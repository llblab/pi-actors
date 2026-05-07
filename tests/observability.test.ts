/**
 * Job observability regression tests
 * Covers compact ambient summaries and terminal transition detection
 */

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mkdtemp } from "node:fs/promises";

import { detectJobTransitions, formatJobTransitionMessage, renderJobStatus, renderSubagentStatus, summarizeJobs } from "../lib/observability.ts";

async function writeJob(
  root: string,
  job: string,
  status: "running" | "done" | "exited",
  failures: unknown[] = [],
  activeSubagents = 0,
): Promise<void> {
  const dir = join(root, job);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "job.json"),
    JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", cwd: process.cwd(), job, pid: status === "running" ? process.pid : 0, stateDir: dir }),
  );
  await writeFile(
    join(dir, "progress.json"),
    JSON.stringify({ activeSubagents, completed: status === "running" ? 0 : 1, failures, updatedAt: `2026-01-01T00:00:0${job.length}.000Z` }),
  );
  if (status === "done") await writeFile(join(dir, "result.json"), JSON.stringify({ code: 0 }));
}

test("Job observability summarizes state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-observe-"));
  try {
    await writeJob(root, "running", "running");
    await writeJob(root, "done", "done");
    const summary = summarizeJobs(root);
    assert.equal(summary.total, 2);
    assert.equal(summary.running, 1);
    assert.equal(summary.done, 1);
    assert.equal(summary.runningSubagents, 0);
    assert.equal(renderJobStatus(summary), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Job observability detects terminal transitions", () => {
  const previous = new Map([["review", "running" as const]]);
  const transitions = detectJobTransitions(previous, {
    done: 1,
    exited: 0,
    jobs: [{ job: "review", status: "done" }],
    running: 0,
    runningSubagents: 0,
    total: 1,
  });
  assert.deepEqual(transitions, [{ from: "running", job: "review", to: "done" }]);
  assert.equal(formatJobTransitionMessage(transitions[0]), "Job review finished with status done. Use template_job action=status or action=tail if analysis is needed.");
  assert.equal(previous.get("review"), "done");
});

test("Job observability renders animated subagent triangles", () => {
  assert.equal(renderSubagentStatus(0), undefined);
  assert.equal(renderSubagentStatus(1, 0), "▶");
  assert.equal(renderSubagentStatus(1, 1), "▷");
  assert.equal(renderSubagentStatus(3, 0), "▶ ▷ ▷");
  assert.equal(renderSubagentStatus(3, 1), "▷ ▶ ▷");
  assert.equal(renderSubagentStatus(3, 2), "▷ ▷ ▶");
  assert.equal(renderSubagentStatus(3, 3), "▶ ▷ ▷");
});

test("Job observability sums active subagents from running jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-observe-"));
  try {
    await writeJob(root, "alpha", "running", [], 3);
    await writeJob(root, "beta", "running", [], 2);
    await writeJob(root, "done", "done", [], 9);
    const summary = summarizeJobs(root);
    assert.equal(summary.runningSubagents, 5);
    assert.equal(renderJobStatus(summary, 4), "▷ ▷ ▷ ▷ ▶");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Job observability hides status when no subagents are running", () => {
  assert.equal(renderJobStatus({ done: 3, exited: 1, jobs: [], running: 2, runningSubagents: 0, total: 4 }), undefined);
});
