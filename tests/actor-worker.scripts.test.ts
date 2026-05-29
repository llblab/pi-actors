/**
 * Actor worker script dogfood tests.
 * Covers script-owned stale-claim visibility through status artifacts and room events.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendBranchInboxMessage, readRoomMessages } from "../lib/rooms.ts";

async function waitForJson(
  path: string,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}: ${String(lastError)}`);
}

test("actor-worker script reports stale claimed branch messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-worker-stale-"));
  const run = "dogfood";
  const branch = "worker";
  const branchAddress = `branch:${run}/${branch}`;
  const inboxDir = join(stateDir, "branches", branch);
  const statusPath = join(stateDir, "worker-status.json");
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "scripts", "actor-worker.mjs"),
      "--state-dir",
      stateDir,
      "--run",
      run,
      "--branch",
      branch,
      "--poll-ms",
      "25",
      "--stale-claim-ms",
      "1",
      "--write-artifacts",
      "false",
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  try {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(
      join(inboxDir, "inbox.jsonl"),
      `${JSON.stringify({
        body: "stuck work",
        claimed_at: new Date(Date.now() - 60_000).toISOString(),
        claimed_by: "branch:dogfood/old-worker",
        from: "run:dogfood",
        id: "stale-1",
        status: "claimed",
        to: branchAddress,
        type: "task.assign",
      })}\n`,
      "utf8",
    );

    const status = await waitForJson(
      statusPath,
      (value) => value.state === "awaiting_assignment",
    );
    assert.equal(status.stale_claims, 1);
    assert.equal(status.stale_claim_ms, 1);

    const awaiting = readRoomMessages(stateDir, "main", 10).find(
      (message) => message.type === "awaiting_assignment",
    );
    assert.equal(awaiting?.body && typeof awaiting.body === "object", true);
    assert.equal(
      (awaiting!.body as Record<string, unknown>).stale_claims,
      1,
    );

    appendBranchInboxMessage(stateDir, run, branchAddress, {
      body: "stop",
      from: "run:dogfood",
      to: branchAddress,
      type: "control.kill",
    });
    const exitCode: number = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
    assert.equal(exitCode, 0, Buffer.concat(stderrChunks).toString("utf8"));
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await rm(stateDir, { recursive: true, force: true });
  }
});
