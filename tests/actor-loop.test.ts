/**
 * Actor loop helper regression tests
 * Covers minimal reusable run/branch mailbox claim and handler status transitions.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendBranchInboxMessage, readBranchInboxMessages } from "../lib/actor-rooms.ts";
import {
  drainActorLoopMessages,
  handleActorLoopOnce,
  isActorLoopStopMessage,
} from "../lib/actor-loop.ts";
import { killRun, readRunInboxMessages, sendRunMessage, startRun } from "../lib/async-runs.ts";

async function waitForStatus(stateDir: string, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const { getRunStatus } = await import("../lib/async-runs.ts");
      if (getRunStatus(stateDir).status === status) return;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

test("Actor loop handles one run inbox message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-loop-run-"));
  const stateDir = join(root, "worker");
  try {
    startRun(
      {
        run_id: "worker",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    await waitForStatus(stateDir, "running");
    await assert.rejects(
      () => sendRunMessage(
        stateDir,
        JSON.stringify({
          body: "work",
          from: "coordinator",
          to: "run:worker",
          type: "task.assign",
        }),
      ),
      /Run control FIFO not found/,
    );

    const seen: unknown[] = [];
    const result = await handleActorLoopOnce(
      { kind: "run", runOrDir: stateDir },
      (message) => {
        seen.push(message.body);
      },
      { owner: "loop-test" },
    );

    assert.equal(result.handled, true);
    assert.deepEqual(seen, ["work"]);
    assert.equal(readRunInboxMessages(stateDir, 1)[0].status, "handled");
  } finally {
    killRun(stateDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor loop marks failed handler messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-loop-failed-"));
  try {
    appendBranchInboxMessage(stateDir, "demo", "branch:demo/worker", {
      body: "bad work",
      from: "run:demo",
      to: "branch:demo/worker",
      type: "task.assign",
    });

    await assert.rejects(
      () =>
        handleActorLoopOnce(
          {
            address: "branch:demo/worker",
            kind: "branch",
            run: "demo",
            stateDir,
          },
          () => {
            throw new Error("boom");
          },
        ),
      /boom/,
    );

    const [message] = readBranchInboxMessages(stateDir, "demo", "branch:demo/worker");
    assert.equal(message.status, "failed");
    assert.equal(message.error, "boom");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor loop recognizes standard stop messages", () => {
  assert.equal(isActorLoopStopMessage({ type: "control.stop" }), true);
  assert.equal(isActorLoopStopMessage({ type: "control.cancel" }), true);
  assert.equal(isActorLoopStopMessage({ type: "control.kill" }), true);
  assert.equal(isActorLoopStopMessage({ type: "task.assign" }), false);
});

test("Actor loop drains available branch messages until stop", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-loop-drain-"));
  try {
    for (const [type, body] of [
      ["task.assign", "first"],
      ["control.stop", "stop"],
      ["task.assign", "after"],
    ] as const) {
      appendBranchInboxMessage(stateDir, "demo", "branch:demo/worker", {
        body,
        from: "run:demo",
        to: "branch:demo/worker",
        type,
      });
    }

    const seen: unknown[] = [];
    const result = await drainActorLoopMessages(
      {
        address: "branch:demo/worker",
        kind: "branch",
        run: "demo",
        stateDir,
      },
      (message) => {
        seen.push(message.body);
      },
      { owner: "loop-test" },
    );

    assert.deepEqual(seen, ["first", "stop"]);
    assert.equal(result.handled, 2);
    assert.equal(result.stopped, true);
    assert.deepEqual(
      readBranchInboxMessages(stateDir, "demo", "branch:demo/worker").map(
        (message) => message.status,
      ),
      ["handled", "handled", "queued"],
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor loop concurrent claims do not double-process one branch message", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-loop-concurrent-"));
  try {
    appendBranchInboxMessage(stateDir, "demo", "branch:demo/worker", {
      body: "single work",
      from: "run:demo",
      to: "branch:demo/worker",
      type: "task.assign",
    });

    const seen: unknown[] = [];
    const target = {
      address: "branch:demo/worker",
      kind: "branch" as const,
      run: "demo",
      stateDir,
    };
    const [first, second] = await Promise.all([
      handleActorLoopOnce(
        target,
        (message) => {
          seen.push(message.body);
        },
        { owner: "loop-a" },
      ),
      handleActorLoopOnce(
        target,
        (message) => {
          seen.push(message.body);
        },
        { owner: "loop-b" },
      ),
    ]);

    assert.equal(Number(first.handled) + Number(second.handled), 1);
    assert.deepEqual(seen, ["single work"]);
    assert.equal(
      readBranchInboxMessages(stateDir, "demo", "branch:demo/worker")[0].status,
      "handled",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Actor loop handles one branch inbox message", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "pi-actors-loop-branch-"));
  try {
    appendBranchInboxMessage(stateDir, "demo", "branch:demo/worker", {
      body: "branch work",
      from: "run:demo",
      to: "branch:demo/worker",
      type: "task.assign",
    });

    const seen: unknown[] = [];
    const result = await handleActorLoopOnce(
      {
        address: "branch:demo/worker",
        kind: "branch",
        run: "demo",
        stateDir,
      },
      (message) => {
        seen.push(message.body);
      },
      { owner: "loop-test" },
    );

    assert.equal(result.handled, true);
    assert.deepEqual(seen, ["branch work"]);
    assert.equal(
      readBranchInboxMessages(stateDir, "demo", "branch:demo/worker")[0].status,
      "handled",
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
