/**
 * Async run observability regression tests
 * Covers compact ambient summaries and terminal transition detection
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  detectRunOutboxEvents,
  detectRunTransitions,
  formatRunOutboxMessage,
  formatRunTransitionMessage,
  getRunOutboxNotificationType,
  getRunTransitionNotificationType,
  renderRunStatus,
  renderSubagentStatus,
  shouldNotifyRunOutboxEvent,
  shouldNotifyRunTransition,
  shouldSendRunOutboxFollowUp,
  shouldSendRunTransitionFollowUp,
  summarizeRuns,
} from "../lib/observability.ts";

async function writeRun(
  root: string,
  run: string,
  status: "running" | "done" | "failed" | "exited" | "cancelled" | "killed",
  failures: unknown[] = [],
  activeSubagents = 0,
  ownerId?: string,
): Promise<void> {
  const dir = join(root, run);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "run.json"),
    JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      cwd: process.cwd(),
      run,
      ...(ownerId ? { ownerId } : {}),
      pid: status === "running" ? process.pid : 999999999,
      state_dir: dir,
    }),
  );
  await writeFile(
    join(dir, "progress.json"),
    JSON.stringify({
      activeSubagents,
      completed: status === "running" ? 0 : 1,
      failures,
      updatedAt: `2026-01-01T00:00:0${run.length}.000Z`,
    }),
  );
  if (status === "done")
    await writeFile(join(dir, "result.json"), JSON.stringify({ code: 0 }));
  if (status === "failed")
    await writeFile(join(dir, "result.json"), JSON.stringify({ code: 1 }));
  if (status === "cancelled")
    await writeFile(
      join(dir, "events.jsonl"),
      JSON.stringify({ event: "run.cancel" }),
    );
  if (status === "killed")
    await writeFile(
      join(dir, "events.jsonl"),
      JSON.stringify({ event: "run.kill" }),
    );
}

test("Run observability summarizes state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "running", "running");
    await writeRun(root, "done", "done");
    await writeRun(root, "failed", "failed");
    await writeRun(root, "cancelled", "cancelled");
    await writeRun(root, "killed", "killed");
    const summary = summarizeRuns(root);
    assert.equal(summary.total, 5);
    assert.equal(summary.running, 1);
    assert.equal(summary.done, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.cancelled, 1);
    assert.equal(summary.killed, 1);
    assert.equal(summary.runningSubagents, 1);
    assert.equal(renderRunStatus(summary), "▶");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability filters summaries by coordinator owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 3, "session-a");
    await writeRun(root, "beta", "running", [], 2, "session-b");
    await writeRun(root, "global", "running", [], 4);
    const summaryA = summarizeRuns(root, "session-a");
    const summaryB = summarizeRuns(root, "session-b");
    assert.deepEqual(
      summaryA.runs.map((run) => run.run),
      ["alpha"],
    );
    assert.equal(summaryA.runningSubagents, 3);
    assert.deepEqual(
      summaryB.runs.map((run) => run.run),
      ["beta"],
    );
    assert.equal(summaryB.runningSubagents, 2);
    assert.equal(summarizeRuns(root).total, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability detects script-authored outbox events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "music", "running", [], 0, "session-a");
    await writeFile(
      join(root, "music", "outbox.jsonl"),
      `${JSON.stringify({ event: "player.track", summary: "Now playing: track.flac", delivery: "followup", level: "info", data: { index: 3, artifacts: { report: join(root, "music", "report.md") }, run_files: [join(root, "music", "stdout.log")] } })}\n`,
    );
    const summary = summarizeRuns(root, "session-a");
    const previous = new Map<string, number>();
    const events = detectRunOutboxEvents(previous, summary);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "player.track");
    assert.equal(events[0].summary, "Now playing: track.flac");
    assert.equal(
      formatRunOutboxMessage(events[0]),
      `Run music: Now playing: track.flac\nArtifacts:\n- Base: \`${join(root, "music")}\`\n- Files: \`report.md\`\nRun files:\n- Base: \`${join(root, "music")}\`\n- Files: \`stdout.log\``,
    );
    assert.equal(getRunOutboxNotificationType(events[0]), "info");
    assert.equal(shouldNotifyRunOutboxEvent(events[0]), true);
    assert.equal(shouldSendRunOutboxFollowUp(events[0]), true);
    assert.deepEqual(detectRunOutboxEvents(previous, summary), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability detects terminal transitions", () => {
  const previous = new Map([["review", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 1,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [
      {
        artifacts: { report: "artifacts/report.md" },
        run: "review",
        status: "done",
      },
    ],
    total: 1,
  });
  assert.deepEqual(transitions, [
    {
      from: "running",
      artifacts: { report: "artifacts/report.md" },
      run: "review",
      to: "done",
    },
  ]);
  assert.equal(
    formatRunTransitionMessage(transitions[0]),
    "Run review completed successfully.\nArtifacts:\n- Base: `artifacts`\n- Files: `report.md`\nUse inspect target=run:review view=status or view=tail if the result needs inspection.",
  );
  assert.equal(previous.get("review"), "done");
});

test("Run observability suppresses terminal follow-up after handled stop messages", () => {
  const transition = {
    from: "running" as const,
    run: "music",
    terminalHandled: true,
    to: "done" as const,
  };
  assert.equal(shouldNotifyRunTransition(transition), false);
  assert.equal(shouldSendRunTransitionFollowUp(transition), false);
});

test("Run observability keeps command done follow-ups compact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "review", "running", [], 0, "session-a");
    await writeFile(
      join(root, "review", "outbox.jsonl"),
      `${JSON.stringify({ event: "command.done", summary: "Command pi completed with code 0", delivery: "followup", level: "info", data: { artifacts: { report: join(root, "review", "report.md") }, run_files: [join(root, "review", "stdout.log")] } })}\n`,
    );
    const events = detectRunOutboxEvents(
      new Map<string, number>(),
      summarizeRuns(root, "session-a"),
    );
    assert.equal(
      formatRunOutboxMessage(events[0]),
      "Run review: Command pi completed with code 0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability detects failed terminal transitions", () => {
  const previous = new Map([["review", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 0,
    done: 0,
    exited: 0,
    failed: 1,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [{ run: "review", status: "failed" }],
    total: 1,
  });
  assert.deepEqual(transitions, [
    { from: "running", run: "review", to: "failed" },
  ]);
});

test("Run observability reports cancelled terminal transitions clearly", () => {
  const previous = new Map([["music", "running" as const]]);
  const transitions = detectRunTransitions(previous, {
    cancelled: 1,
    done: 0,
    exited: 0,
    failed: 0,
    killed: 0,
    running: 0,
    runningSubagents: 0,
    runs: [{ run: "music", status: "cancelled" }],
    total: 1,
  });
  assert.deepEqual(transitions, [
    { from: "running", run: "music", to: "cancelled" },
  ]);
  assert.equal(
    formatRunTransitionMessage(transitions[0]),
    "Run music was cancelled. Use inspect target=run:music view=status or view=tail if analysis is needed.",
  );
  assert.equal(getRunTransitionNotificationType(transitions[0]), "info");
  assert.equal(shouldSendRunTransitionFollowUp(transitions[0]), false);
});

test("Run observability suppresses duplicate handled terminal transitions", () => {
  const failed = {
    from: "running" as const,
    run: "review",
    to: "failed" as const,
  };
  const killed = {
    from: "running" as const,
    run: "review",
    to: "killed" as const,
  };
  const done = { from: "running" as const, run: "review", to: "done" as const };
  const cancelled = {
    from: "running" as const,
    run: "review",
    to: "cancelled" as const,
  };
  assert.equal(getRunTransitionNotificationType(failed), "error");
  assert.equal(getRunTransitionNotificationType(killed), "warning");
  assert.equal(getRunTransitionNotificationType(done), "info");
  assert.equal(shouldNotifyRunTransition(failed), true);
  assert.equal(shouldNotifyRunTransition(cancelled), false);
  assert.equal(shouldNotifyRunTransition(done), true);
  assert.equal(shouldNotifyRunTransition(killed), true);
  assert.equal(shouldSendRunTransitionFollowUp(failed), true);
  assert.equal(shouldSendRunTransitionFollowUp(cancelled), false);
  assert.equal(shouldSendRunTransitionFollowUp(killed), true);
  assert.equal(shouldSendRunTransitionFollowUp(done), true);
});

test("Run observability renders animated subagent triangles", () => {
  assert.equal(renderSubagentStatus(0), undefined);
  assert.equal(renderSubagentStatus(1, 0), "▶");
  assert.equal(renderSubagentStatus(1, 1), "▷");
  assert.equal(renderSubagentStatus(3, 0), "▶ ▷ ▷");
  assert.equal(renderSubagentStatus(3, 1), "▷ ▶ ▷");
  assert.equal(renderSubagentStatus(3, 2), "▷ ▷ ▶");
  assert.equal(renderSubagentStatus(3, 3), "▶ ▷ ▷");
});

test("Run observability counts active parallel branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 3);
    await writeRun(root, "beta", "running", [], 2);
    await writeRun(root, "done", "done", [], 9);
    const summary = summarizeRuns(root);
    assert.equal(summary.running, 2);
    assert.equal(summary.runningSubagents, 5);
    assert.equal(renderRunStatus(summary, 1), "▷ ▶ ▷ ▷ ▷");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability keeps at least one triangle per running async run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-observe-"));
  try {
    await writeRun(root, "alpha", "running", [], 0);
    await writeRun(root, "beta", "running", [], 2);
    await writeRun(root, "gamma", "running", [], 0);
    const summary = summarizeRuns(root);
    assert.equal(summary.running, 3);
    assert.equal(summary.runningSubagents, 4);
    assert.equal(renderRunStatus(summary, 1), "▷ ▶ ▷ ▷");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Run observability hides status when no runs are running", () => {
  assert.equal(
    renderRunStatus({
      cancelled: 0,
      done: 3,
      exited: 1,
      failed: 0,
      killed: 0,
      running: 0,
      runningSubagents: 0,
      runs: [],
      total: 4,
    }),
    undefined,
  );
});
