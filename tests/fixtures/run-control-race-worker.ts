/**
 * Child-process fixture for deterministic restart-vs-control lifecycle locking.
 * Owns held canonical kill and same-directory restart attempts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getRunStatus, killRun, startRun } from "../../lib/async-runs.ts";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing race fixture config.");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  blockedPath?: string;
  mode: "control" | "restart";
  readyPath?: string;
  releasePath?: string;
  stateDir: string;
};

try {
  if (config.mode === "control") {
    const status = getRunStatus(config.stateDir);
    const result = killRun(config.stateDir, {
      onLocked: () => {
        if (!config.readyPath || !config.releasePath) return;
        writeFileSync(config.readyPath, "ready\n");
        while (!existsSync(config.releasePath)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      },
      ownerId: String(status.ownerId),
      runInstanceId: String(status.run_instance_id),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    startRun(
      {
        lifecycleHooks: {
          onLockContention: () => {
            if (config.blockedPath)
              writeFileSync(config.blockedPath, "blocked\n");
          },
        },
        ownerId: "session-b",
        run_id: "replacement",
        state_dir: config.stateDir,
        template: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      },
      process.cwd(),
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
