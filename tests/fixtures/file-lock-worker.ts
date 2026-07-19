/**
 * Child-process fixture for deterministic canonical file-lock contention.
 * Owns barrier signaling, held-lock release, and crash-owner simulation.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

import {
  mutationLockPath,
  withFileMutationLock,
} from "../../lib/file-state.ts";

const [
  target,
  startedPath,
  acquiredPath,
  blockedPath,
  releasePath,
  logPath,
  mode,
  reclaimReadyPath,
  reclaimProceedPath,
] = process.argv.slice(2);
if (
  !target ||
  !startedPath ||
  !acquiredPath ||
  !blockedPath ||
  !releasePath ||
  !logPath
) {
  throw new Error("Missing file-lock worker arguments.");
}

writeFileSync(startedPath, "started\n");
withFileMutationLock(
  target,
  () => {
    appendFileSync(logPath, `${mode ?? "hold"}:acquired\n`);
    writeFileSync(acquiredPath, "acquired\n");
    if (mode === "crash") process.exit(73);
    if (mode === "unknown-owner") {
      const lockPath = mutationLockPath(target);
      const ownerPath = `${lockPath}/owner.json`;
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<
        string,
        unknown
      >;
      writeFileSync(
        ownerPath,
        `${JSON.stringify({ ...owner, pid: "unknown" })}\n`,
      );
      utimesSync(lockPath, new Date(0), new Date(0));
    }
    while (!existsSync(releasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    appendFileSync(logPath, `${mode ?? "hold"}:released\n`);
  },
  {
    onBeforeReclaimRemove: () => {
      if (!reclaimReadyPath || !reclaimProceedPath) return;
      writeFileSync(reclaimReadyPath, "ready\n");
      while (!existsSync(reclaimProceedPath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    },
    onContention: () => writeFileSync(blockedPath, "blocked\n"),
    onRemovalContention: () => writeFileSync(blockedPath, "removal-blocked\n"),
  },
);
