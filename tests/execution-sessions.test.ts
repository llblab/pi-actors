import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as ExecutionSessions from "../lib/execution-sessions.ts";
import * as SessionEvidence from "../lib/session-evidence.ts";

test("Execution chronology joins pre-tail session metadata without widening body reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-execution-chronology-"));
  const files = ["sessions/alpha/session.jsonl", "sessions/beta/session.jsonl"];
  const commands = files.map((file, index) => ({ id: `command-${index}`, session_files: [file] }));
  const source = (count: number, sessionId = "session") => [JSON.stringify({ type: "session", version: 3, id: sessionId }),
    ...Array.from({ length: count }, (_, index) => JSON.stringify({ type: "message", id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null, timestamp: new Date(index).toISOString(),
      message: { role: "assistant", content: "BODY_CANARY" } }))].join("\n") + "\n";
  try {
    for (const [index, file] of files.entries()) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), source(index ? 1 : 101));
    }
    const manifest = join(root, "execution.json");
    await writeFile(manifest, JSON.stringify({ commands }));
    const before = await readFile(join(root, files[0]));
    const turns = ExecutionSessions.readExecutionTurns(root);
    const frame = turns[ExecutionSessions.EXECUTION_CHRONOLOGY];
    assert.ok(frame);
    assert.equal(frame.state, "available");
    assert.equal(frame.basis, "recorded_execution_metadata");
    assert.equal(frame.entries.length, 102);
    assert.equal(turns.length, 101);
    assert.equal(frame.entries[101].ordinal, 102);
    assert.equal(frame.entries[101].sessionOrdinal, 1);
    assert.equal(frame.entries[101].commandId, "command-1");
    assert.equal(frame.entries[101].identity, turns[100][SessionEvidence.SESSION_TURN_IDENTITY]);
    assert.equal(turns[100].index, 101, "Existing body aggregate indices stay unchanged");
    assert.doesNotMatch(JSON.stringify(frame), /BODY_CANARY|assistantText|toolCalls|recipeContext/);
    assert.doesNotMatch(JSON.stringify(turns), /recorded_execution_metadata/);
    assert.ok(Object.isFrozen(frame) && Object.isFrozen(frame.entries) && Object.isFrozen(frame.entries[0]));
    assert.ok((await readFile(join(root, files[0]))).equals(before));
    const lstat = fs.lstatSync; let discoveryRejected = false;
    fs.lstatSync = ((path, ...args) => {
      if (!discoveryRejected && String(path) === join(root, "sessions")) { discoveryRejected = true; throw undefined; }
      return Reflect.apply(lstat, fs, [path, ...args]);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try {
      const degraded = ExecutionSessions.readExecutionTurns(root);
      assert.equal(discoveryRejected, true);
      assert.equal(degraded.length, 101, "Unknown discovery rejection must preserve legacy recorded-file body reads");
      assert.equal(degraded[ExecutionSessions.EXECUTION_CHRONOLOGY]?.state, "unavailable");
    } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
    await unlink(join(root, files[1]));
    const missing = ExecutionSessions.readExecutionTurns(root);
    assert.equal(missing.length, 100);
    assert.equal(missing[ExecutionSessions.EXECUTION_CHRONOLOGY]?.state, "unavailable");
    assert.deepEqual(missing[ExecutionSessions.EXECUTION_CHRONOLOGY]?.entries, []);
    await writeFile(join(root, files[1]), source(1));
    for (const command of [{ session_files: [files[0]] }, { ...commands[0], session_files: [files[0], 42] }]) {
      await writeFile(manifest, JSON.stringify({ commands: [command] }));
      const legacy = ExecutionSessions.readExecutionTurns(root);
      assert.equal(legacy.length, 101, "Metadata cannot tighten the old body reader's declared/discovered source policy");
      assert.equal(legacy[ExecutionSessions.EXECUTION_CHRONOLOGY]?.state, "unavailable", "Do not mint missing namespace or source-schema facts");
    }
    await writeFile(manifest, JSON.stringify({ commands: [{ ...commands[0], id: "token=HIDDEN" }] }));
    const privateNamespace = ExecutionSessions.readExecutionTurns(root)[ExecutionSessions.EXECUTION_CHRONOLOGY]!;
    assert.equal(privateNamespace.state, "unavailable");
    if (privateNamespace.state === "unavailable") assert.equal(privateNamespace.reason, "namespace_unavailable");
    await writeFile(join(root, files[0]), source(520, "s".repeat(4000)));
    await writeFile(manifest, JSON.stringify({ commands: [{ ...commands[0], id: "c".repeat(4000) }, commands[1]] }));
    const large = ExecutionSessions.readExecutionTurns(root);
    const overBudget = large[ExecutionSessions.EXECUTION_CHRONOLOGY]!;
    assert.equal(overBudget.state, "unavailable");
    if (overBudget.state === "unavailable") assert.equal(overBudget.reason, "metadata_too_large");
    assert.deepEqual(overBudget.entries, []);
    assert.equal(large.length, 101, "Aggregate metadata refusal is not a body/work quota");
  } finally { await rm(root, { force: true, recursive: true }); }
});
