/**
 * Parent-session teardown regressions.
 * Covers exact-owner selection, lifecycle races, partial failures, and idempotency.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBoundedParentTeardownSummary,
  selectParentRunTeardownCandidates,
  teardownParentRuns,
  type ParentRunTeardownAttempt,
} from "../lib/runs-parent-teardown.ts";

function status(
  run: string,
  ownerId: string | undefined,
  runStatus = "running",
  stateDir = `/runs/${run}`,
): Record<string, unknown> {
  return {
    ...(ownerId ? { ownerId } : {}),
    run,
    run_instance_id: `${run}-instance`,
    state_dir: stateDir,
    status: runStatus,
  };
}

test("Selects only exact-owner running runs, including nested state paths", () => {
  assert.deepEqual(
    selectParentRunTeardownCandidates("session-a", [
      status("terminal", "session-a", "done"),
      status("other", "session-b"),
      status("ambiguous", undefined),
      status("nested", "session-a", "running", "/runs/root/children/nested"),
      status("direct", "session-a"),
      status("duplicate", "session-a", "running", "/runs/direct"),
    ]),
    [
      {
        ownerId: "session-a",
        run: "direct",
        runInstanceId: "direct-instance",
        stateDir: "/runs/direct",
      },
      {
        ownerId: "session-a",
        run: "nested",
        runInstanceId: "nested-instance",
        stateDir: "/runs/root/children/nested",
      },
    ],
  );
  assert.deepEqual(selectParentRunTeardownCandidates(undefined, []), []);
});

test("Kills every still-running exact-owner run and records each outcome", () => {
  const statuses = [status("a", "session-a"), status("b", "session-a")];
  const killed: string[] = [];
  const evidence: ParentRunTeardownAttempt[] = [];
  const result = teardownParentRuns("session-a", {
    getRunStatus: (stateDir) =>
      statuses.find((entry) => entry.state_dir === stateDir)!,
    killRun: (stateDir) => {
      killed.push(stateDir);
      return { killed: true };
    },
    listRunStatuses: () => statuses,
    recordAttempt: (attempt) => evidence.push(attempt),
  });

  assert.deepEqual(killed, ["/runs/a", "/runs/b"]);
  assert.deepEqual(result, {
    attempted: 2,
    discoveryFailed: 0,
    discoveryFailures: [],
    failed: 0,
    killed: 2,
    skipped: 0,
    attempts: evidence,
  });
  assert.equal(evidence.every((attempt) => attempt.outcome === "killed"), true);
});

test("Revalidates ownership and terminal state before kill", () => {
  const statuses = [
    status("moved", "session-a"),
    status("finished", "session-a"),
  ];
  const current = new Map<string, Record<string, unknown>>([
    ["/runs/moved", status("moved", "session-b")],
    ["/runs/finished", status("finished", "session-a", "done")],
  ]);
  const evidence: ParentRunTeardownAttempt[] = [];
  const result = teardownParentRuns("session-a", {
    getRunStatus: (stateDir) => current.get(stateDir)!,
    killRun: () => assert.fail("race candidates must not be killed"),
    listRunStatuses: () => statuses,
    recordAttempt: (attempt) => evidence.push(attempt),
  });

  assert.equal(result.killed, 0);
  assert.equal(result.skipped, 2);
  assert.deepEqual(
    evidence.map((attempt) => attempt.reason).sort(),
    ["already terminal", "ownership changed"],
  );
});

test("Rejects same-owner replacement generations before canonical kill", () => {
  const initial = status("run", "session-a");
  const replacement = {
    ...initial,
    run_instance_id: "replacement-instance",
  };
  const result = teardownParentRuns("session-a", {
    getRunStatus: () => replacement,
    killRun: () => assert.fail("replacement generation must not be killed"),
    listRunStatuses: () => [initial],
    recordAttempt: () => undefined,
  });

  assert.deepEqual(result.attempts, [
    {
      ownerId: "session-a",
      outcome: "skipped",
      reason: "run generation changed",
      run: "run",
      runInstanceId: "run-instance",
      stateDir: "/runs/run",
    },
  ]);
});

test("Continues after kill and evidence failures", () => {
  const statuses = [
    status("evidence", "session-a"),
    status("kill-false", "session-a"),
    status("kill-throws", "session-a"),
    status("ok", "session-a"),
  ];
  const result = teardownParentRuns("session-a", {
    getRunStatus: (stateDir) =>
      statuses.find((entry) => entry.state_dir === stateDir)!,
    killRun: (stateDir) => {
      if (stateDir.endsWith("kill-false")) {
        return { killed: false, reason: "owner mismatch" };
      }
      if (stateDir.endsWith("kill-throws")) throw new Error("signal failed");
      return { killed: true };
    },
    listRunStatuses: () => statuses,
    recordAttempt: (attempt) => {
      if (attempt.run === "evidence") throw new Error("disk full");
    },
  });

  assert.equal(result.attempted, 4);
  assert.equal(result.killed, 1);
  assert.equal(result.failed, 3);
  assert.deepEqual(
    result.attempts.map((attempt) => [attempt.run, attempt.outcome, attempt.reason]),
    [
      ["evidence", "failed", "evidence: disk full"],
      ["kill-false", "failed", "owner mismatch"],
      ["kill-throws", "failed", "signal failed"],
      ["ok", "killed", undefined],
    ],
  );
});

test("Discovery failures remain visible while readable runs continue", () => {
  const owned = status("owned", "session-a");
  const result = teardownParentRuns("session-a", {
    getRunStatus: () => owned,
    killRun: () => ({ killed: true }),
    listRunStatuses: () => ({
      failures: [{ path: "/runs/corrupt", reason: "invalid run.json" }],
      statuses: [owned],
    }),
    recordAttempt: () => undefined,
  });

  assert.equal(result.killed, 1);
  assert.equal(result.discoveryFailed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.discoveryFailures, [
    { path: "/runs/corrupt", reason: "invalid run.json" },
  ]);
});

test("Persisted teardown summaries bound every string and collection", () => {
  const huge = "x".repeat(5_000);
  const attempts = Array.from({ length: 201 }, (_, index) => ({
    ownerId: `${index}-${huge}`,
    outcome: "failed" as const,
    reason: huge,
    run: huge,
    runInstanceId: huge,
    stateDir: huge,
  }));
  const discoveryFailures = Array.from({ length: 201 }, () => ({
    path: huge,
    reason: huge,
  }));
  const summary = buildBoundedParentTeardownSummary(
    {
      attempted: attempts.length,
      attempts,
      discoveryFailed: discoveryFailures.length,
      discoveryFailures,
      failed: attempts.length,
      killed: 0,
      skipped: 0,
    },
    huge,
    huge,
    huge,
  );

  assert.equal(summary.attempts.length, 200);
  assert.equal(summary.attemptsOmitted, 1);
  assert.equal(summary.discoveryFailures.length, 200);
  assert.equal(summary.discoveryFailuresOmitted, 1);
  const strings: string[] = [
    summary.ownerId,
    summary.trigger,
    summary.ts,
    ...summary.attempts.flatMap((attempt) => [
      attempt.ownerId,
      attempt.reason ?? "",
      attempt.run,
      attempt.runInstanceId ?? "",
      attempt.stateDir,
    ]),
    ...summary.discoveryFailures.flatMap((failure) => [
      failure.path,
      failure.reason,
    ]),
  ];
  assert.equal(strings.every((value) => value.length <= 500), true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 750_000);
});

test("A second teardown is idempotent after runs become terminal", () => {
  let statuses = [status("run", "session-a")];
  const first = teardownParentRuns("session-a", {
    getRunStatus: () => statuses[0],
    killRun: () => {
      statuses = [status("run", "session-a", "killed")];
      return { killed: true };
    },
    listRunStatuses: () => statuses,
    recordAttempt: () => {},
  });
  const second = teardownParentRuns("session-a", {
    getRunStatus: () => assert.fail("no terminal candidate should revalidate"),
    killRun: () => assert.fail("no terminal candidate should kill"),
    listRunStatuses: () => statuses,
    recordAttempt: () => assert.fail("no terminal candidate should record"),
  });

  assert.equal(first.killed, 1);
  assert.deepEqual(second, {
    attempted: 0,
    discoveryFailed: 0,
    discoveryFailures: [],
    failed: 0,
    killed: 0,
    skipped: 0,
    attempts: [],
  });
});
