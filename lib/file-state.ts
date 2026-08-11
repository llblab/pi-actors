/**
 * File state persistence helpers
 * Zones: file persistence, atomic writes, runtime state support
 * Owns generic durable JSON file writes shared by registry config and async run state.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const FILE_MUTATION_LOCK_TIMEOUT_MS = process.platform === "win32" ? 15000 : 5000;
const FILE_MUTATION_LOCK_STALE_MS = 30000;
const FILE_MUTATION_LOCK_ROOT = join(tmpdir(), "pi-actors-file-locks");

function canonicalMutationPath(path: string): string {
  const absolute = resolve(path);
  try {
    if (lstatSync(absolute).isSymbolicLink()) {
      const target = realpathSync.native(absolute);
      return process.platform === "win32" ? target.toLowerCase() : target;
    }
  } catch {
    /* Materialization may race lock-key derivation; canonicalize through the parent. */
  }
  const suffix: string[] = [basename(absolute)];
  let existing = dirname(absolute);
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

function isZombieProcess(pid: number): boolean {
  if (process.platform === "linux") try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch { return false; }
  if (process.platform !== "darwin") return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
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
      if (Date.now() - statSync(lockPath).mtimeMs > 50 && isZombieProcess(pid)) return "dead";
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
  onBeforeLockPublish?(): void;
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

function prepareLockBoundary(lockPath: string, token: string, onBeforePublish?: () => void): string {
  const pendingPath = `${lockPath}.${process.pid}.${token}.pending`;
  try {
    mkdirSync(pendingPath);
    writeFileSync(join(pendingPath, "owner.json"), `${JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() })}\n`, "utf8");
    onBeforePublish?.();
    return pendingPath;
  } catch (error) {
    try { rmSync(pendingPath, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

function removeLockBoundary(lockPath: string, token: string | undefined): boolean {
  if (readLockToken(lockPath) !== token) return false;
  if (process.platform === "win32") try { rmSync(lockPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 5 }); return true; } catch { return false; }
  const removingPath = `${lockPath}.${process.pid}.${randomUUID()}.removing`;
  try { renameSync(lockPath, removingPath); } catch { return false; }
  try { rmSync(removingPath, { recursive: true, force: true }); } catch {}
  return true;
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
      removeLockBoundary(reclaimPath, inspectedToken);
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
  const pendingPath = prepareLockBoundary(reclaimPath, token);
  try {
    try { renameSync(pendingPath, reclaimPath); } catch {
      tryReclaimRemovalBoundary(reclaimPath);
      return false;
    }
    try {
      action();
      return true;
    } finally {
      removeLockBoundary(reclaimPath, token);
    }
  } finally {
    try { rmSync(pendingPath, { recursive: true, force: true }); } catch {}
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
      reclaimed = removeLockBoundary(lockPath, inspectedToken);
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
  const pendingPath = prepareLockBoundary(lockPath, token, options.onBeforeLockPublish);
  let contentionReported = false;
  try {
    for (;;) {
      try {
        renameSync(pendingPath, lockPath);
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
  } finally {
    try { rmSync(pendingPath, { recursive: true, force: true }); } catch {}
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const deadline = Date.now() + FILE_MUTATION_LOCK_TIMEOUT_MS;
    let removalContentionReported = false;
    while (
      !withRemovalBoundary(lockPath, () => {
        removeLockBoundary(lockPath, token);
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

export function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, "utf8");
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

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
