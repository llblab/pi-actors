/**
 * File state persistence helpers
 * Zones: file persistence, atomic writes, runtime state support
 * Owns generic durable JSON file writes shared by registry config and async run state.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const FILE_MUTATION_LOCK_TIMEOUT_MS = 5000;
const FILE_MUTATION_LOCK_STALE_MS = 30000;
const FILE_MUTATION_LOCK_ROOT = join(tmpdir(), "pi-actors-file-locks");

function canonicalMutationPath(path: string): string {
  const absolute = resolve(path);
  const suffix: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing || existing === parse(existing).root) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const canonicalAncestor = existsSync(existing)
    ? realpathSync.native(existing)
    : existing;
  const canonical = resolve(canonicalAncestor, ...suffix);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function mutationLockPath(path: string): string {
  const key = createHash("sha256")
    .update(canonicalMutationPath(path))
    .digest("hex");
  return join(FILE_MUTATION_LOCK_ROOT, `${key}.lock`);
}

function lockOwnerIsDead(lockPath: string): boolean {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockPath, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}

export function withFileMutationLock<T>(path: string, mutate: () => T): T {
  mkdirSync(FILE_MUTATION_LOCK_ROOT, { recursive: true });
  const lockPath = mutationLockPath(path);
  const deadline = Date.now() + FILE_MUTATION_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
          "utf8",
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      try {
        if (
          Date.now() - statSync(lockPath).mtimeMs >
            FILE_MUTATION_LOCK_STALE_MS &&
          lockOwnerIsDead(lockPath)
        ) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file mutation lock: ${canonicalMutationPath(path)}`, {
          cause: error,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return mutate();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    throw error;
  }
}
