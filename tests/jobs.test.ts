/**
 * Async job primitive regression tests
 * Covers detached state files, status/list/tail, and cancellation stale-state behavior
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RegisteredTool } from "../lib/config.ts";
import { cancelJob, getJobStatus, listJobs, startJob, tailJob } from "../lib/jobs.ts";

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

test("Template jobs can start from registered tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-auto-tools-jobs-"));
  const stateDir = join(root, "tool-job");
  const tool: RegisteredTool = {
    args: ["name"],
    defaults: {},
    description: "Say hello",
    name: "hello_tool",
    template: `${process.execPath} -e "console.log('hello ' + process.argv[1])" {name}`,
  };
  try {
    const meta = startJob(
      {
        job: "tool-job",
        state_dir: stateDir,
        tool: "hello_tool",
        values: { name: "tool" },
      },
      process.cwd(),
      new Map([[tool.name, tool]]),
    );
    assert.equal(meta.tool, "hello_tool");
    const result = await waitForResult(stateDir);
    assert.equal(result.code, 0);
    assert.match(await readFile(join(stateDir, "stdout.log"), "utf8"), /hello tool/);
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
