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

export function mutationLockPath(path: string): string {
  const key = createHash("sha256")
    .update(canonicalMutationPath(path))
    .digest("hex");
  return join(FILE_MUTATION_LOCK_ROOT, `${key}.lock`);
}

function lockOwnerStatus(lockPath: string): "alive" | "dead" | "unknown" {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockPath, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return "unknown";
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? "dead"
        : "unknown";
    }
  } catch {
    return "unknown";
  }
}

export interface FileMutationLockOptions {
  onBeforeReclaimRemove?(): void;
  onContention?(): void;
  onRemovalContention?(): void;
}

function readLockToken(lockPath: string): string | undefined {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockPath, "owner.json"), "utf8"),
    ) as { token?: unknown };
    return typeof owner.token === "string" ? owner.token : undefined;
  } catch {
    return undefined;
  }
}

function tryReclaimRemovalBoundary(reclaimPath: string): void {
  if (!existsSync(reclaimPath)) return;
  try {
    const inspectedToken = readLockToken(reclaimPath);
    const age = Date.now() - statSync(reclaimPath).mtimeMs;
    const ownerStatus = lockOwnerStatus(reclaimPath);
    if (
      (ownerStatus === "dead" ||
        (ownerStatus === "unknown" && age > FILE_MUTATION_LOCK_STALE_MS)) &&
      readLockToken(reclaimPath) === inspectedToken
    ) {
      rmSync(reclaimPath, { recursive: true, force: true });
    }
  } catch {
    /* another contender changed the boundary */
  }
}

function withRemovalBoundary(
  lockPath: string,
  action: () => void,
): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  try {
    mkdirSync(reclaimPath);
    try {
      writeFileSync(
        join(reclaimPath, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`,
        "utf8",
      );
    } catch (error) {
      rmSync(reclaimPath, { recursive: true, force: true });
      throw error;
    }
  } catch {
    tryReclaimRemovalBoundary(reclaimPath);
    return false;
  }
  try {
    action();
    return true;
  } finally {
    if (readLockToken(reclaimPath) === token) {
      rmSync(reclaimPath, { recursive: true, force: true });
    }
  }
}

function tryReclaimMutationLock(
  lockPath: string,
  options: FileMutationLockOptions,
): boolean {
  let reclaimed = false;
  if (!withRemovalBoundary(lockPath, () => {
    if (!existsSync(lockPath)) {
      reclaimed = true;
      return;
    }
    const inspectedToken = readLockToken(lockPath);
    const age = Date.now() - statSync(lockPath).mtimeMs;
    const ownerStatus = lockOwnerStatus(lockPath);
    if (
      (ownerStatus === "dead" ||
        (ownerStatus === "unknown" && age > FILE_MUTATION_LOCK_STALE_MS)) &&
      readLockToken(lockPath) === inspectedToken
    ) {
      options.onBeforeReclaimRemove?.();
      rmSync(lockPath, { recursive: true, force: true });
      reclaimed = true;
    }
  })) {
    return false;
  }
  return reclaimed;
}

export function acquireFileMutationLock(
  path: string,
  options: FileMutationLockOptions = {},
): () => void {
  mkdirSync(FILE_MUTATION_LOCK_ROOT, { recursive: true });
  const lockPath = mutationLockPath(path);
  const deadline = Date.now() + FILE_MUTATION_LOCK_TIMEOUT_MS;
  const token = randomUUID();
  let contentionReported = false;
  for (;;) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`,
          "utf8",
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!contentionReported) {
        contentionReported = true;
        options.onContention?.();
      }
      tryReclaimMutationLock(lockPath, options);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for file mutation lock: ${canonicalMutationPath(path)}`, {
          cause: error,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const deadline = Date.now() + FILE_MUTATION_LOCK_TIMEOUT_MS;
    let removalContentionReported = false;
    while (
      !withRemovalBoundary(lockPath, () => {
        if (readLockToken(lockPath) === token) {
          rmSync(lockPath, { recursive: true, force: true });
        }
      })
    ) {
      if (!removalContentionReported) {
        removalContentionReported = true;
        options.onRemovalContention?.();
      }
      if (Date.now() >= deadline) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
}

export function withFileMutationLock<T>(
  path: string,
  mutate: () => T,
  options: FileMutationLockOptions = {},
): T {
  const release = acquireFileMutationLock(path, options);
  try {
    return mutate();
  } finally {
    release();
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
