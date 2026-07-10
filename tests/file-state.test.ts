/**
 * File state persistence tests
 * Covers atomic JSON temp-file collision resistance.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { fileURLToPath, pathToFileURL } from "node:url";

import { writeJsonAtomic } from "../lib/file-state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runLockProcess(moduleUrl: string, file: string, log: string): Promise<void> {
  const script = `
    const { appendFileSync } = await import("node:fs");
    const { withFileMutationLock } = await import(process.argv[1]);
    withFileMutationLock(process.argv[2], () => {
      appendFileSync(process.argv[3], "start\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
      appendFileSync(process.argv[3], "end\\n");
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "-e", script, moduleUrl, file, log],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)),
    );
  });
}

test("File mutation locks serialize sibling processes by canonical path", async () => {
  const root = join(tmpdir(), `pi-actors-file-lock-${process.pid}-${Date.now()}`);
  const file = join(root, "recipe.json");
  const log = join(root, "order.log");
  const moduleUrl = pathToFileURL(join(__dirname, "..", "lib", "file-state.ts")).href;
  try {
    await mkdir(root, { recursive: true });
    await Promise.all([
      runLockProcess(moduleUrl, file, log),
      runLockProcess(moduleUrl, file, log),
    ]);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "start",
      "end",
      "start",
      "end",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "File mutation locks serialize real and symlinked parent aliases",
  { skip: process.platform === "win32" },
  async () => {
    const root = join(
      tmpdir(),
      `pi-actors-file-lock-alias-${process.pid}-${Date.now()}`,
    );
    const realParent = join(root, "real");
    const aliasParent = join(root, "alias");
    const log = join(root, "order.log");
    const moduleUrl = pathToFileURL(
      join(__dirname, "..", "lib", "file-state.ts"),
    ).href;
    try {
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, aliasParent, "dir");
      await Promise.all([
        runLockProcess(moduleUrl, join(realParent, "recipe.json"), log),
        runLockProcess(moduleUrl, join(aliasParent, "recipe.json"), log),
      ]);
      assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
        "start",
        "end",
        "start",
        "end",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("writeJsonAtomic uses collision-resistant temp names", async () => {
  const root = join(tmpdir(), `pi-actors-file-state-${process.pid}-${Date.now()}`);
  const file = join(root, "state.json");
  const originalNow = Date.now;
  try {
    Date.now = () => 1234567890;
    for (let i = 0; i < 50; i += 1) {
      writeJsonAtomic(file, { i });
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as { i: number };
    assert.equal(parsed.i, 49);
    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    Date.now = originalNow;
    await rm(root, { recursive: true, force: true });
  }
});
