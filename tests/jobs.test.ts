/**
 * Async job primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cancelJob, getJobStatus, killJob, listJobs, startJob, tailJob } from "../lib/jobs.ts";

async function waitForResult(stateDir: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const status = getJobStatus(stateDir);
    if (status.result) return status.result as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("job did not finish");
}

test("Template jobs write state files and finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "hello");
  try {
    const meta = startJob(
      {
        job: "hello",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('hello ' + process.argv[1])" {name}`,
        values: { name: "world" },
      },
      process.cwd(),
    );
    assert.equal(meta.job, "hello");
    assert.equal(meta.ownerId, undefined);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const status = getJobStatus(stateDir);
    assert.equal(status.status, "done");
    assert.equal((listJobs(root)[0] || {}).job, "hello");
    assert.match(tailJob(stateDir), /job\.(start|runner\.start|done)/);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello world/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template jobs persist coordinator owner ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "owned");
  try {
    const meta = startJob(
      {
        job: "owned",
        ownerId: "session-a",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('owned')"`,
      },
      process.cwd(),
    );
    assert.equal(meta.ownerId, "session-a");
    await waitForResult(stateDir);
    assert.equal(getJobStatus(stateDir).ownerId, "session-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template jobs can start from template job files with overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "file-job");
  const file = join(root, "say.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          job: "from-file",
          state_dir: stateDir,
          template: `${process.execPath} -e "console.log(process.argv[1] + ' ' + process.argv[2])" {greeting} {name}`,
          values: { greeting: "hello", name: "file" },
        },
        null,
        2,
      ),
    );
    const meta = startJob(
      { file, job: "override-job", values: { name: "override" } },
      process.cwd(),
    );
    assert.equal(meta.job, "override-job");
    assert.equal(meta.values.greeting, "hello");
    assert.equal(meta.values.name, "override");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello override/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template job files can put command-template flags at the job top level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "top-level-mode");
  const file = join(root, "parallel.json");
  try {
    await writeFile(
      file,
      JSON.stringify(
        {
          job: "top-level-mode",
          state_dir: stateDir,
          mode: "parallel",
          template: [
            `${process.execPath} -e "console.log('left')"`,
            `${process.execPath} -e "console.log('right')"`,
          ],
        },
        null,
        2,
      ),
    );
    const meta = startJob({ file }, process.cwd());
    assert.equal(meta.job, "top-level-mode");
    assert.equal(typeof meta.template, "object");
    assert.equal(Array.isArray(meta.template), false);
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    assert.match(stdout, /left/);
    assert.match(stdout, /right/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template job files reject tool references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const file = join(root, "tool-job.json");
  try {
    await writeFile(
      file,
      JSON.stringify({ job: "tool-job", tool: "hello_tool" }, null, 2),
    );
    assert.throws(
      () => startJob({ file }, process.cwd()),
      /Job recipe cannot define tool/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template job cancel terminates matching running jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "running");
  try {
    startJob(
      {
        job: "running",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getJobStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = cancelJob(stateDir);
    assert.equal(result.cancelled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template job kill terminates matching stuck jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "stuck");
  try {
    startJob(
      {
        job: "stuck",
        state_dir: stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
    for (let i = 0; i < 20; i++) {
      if (getJobStatus(stateDir).status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const result = killJob(stateDir);
    assert.equal(result.killed, true);
    assert.equal(result.signal, "SIGKILL");
    assert.match(tailJob(stateDir), /job\.kill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template job cancel fails closed for completed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "done");
  try {
    startJob(
      {
        job: "done",
        state_dir: stateDir,
        template: `${process.execPath} -e "console.log('done')"`,
      },
      process.cwd(),
    );
    await waitForResult(stateDir);
    const result = cancelJob(stateDir);
    assert.equal(result.cancelled, false);
    assert.equal(result.reason, "not running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
