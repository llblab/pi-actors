/**
 * Child-process fixture for draft consolidation contention and crash checkpoints.
 * Owns one apply attempt from a serialized test configuration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { DraftConsolidationPlan } from "../../lib/draft-consolidation.ts";
import {
  applyDraftConsolidationPlan,
  type DraftConsolidationCheckpoint,
  type DraftConsolidationTransactionOptions,
} from "../../lib/draft-consolidation-transaction.ts";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing fixture config path.");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  blockedPath?: string;
  crashAt?: DraftConsolidationCheckpoint;
  holdAt?: DraftConsolidationCheckpoint;
  options: Omit<DraftConsolidationTransactionOptions, "checkpoint">;
  readyPath?: string;
  releasePath?: string;
  startedPath?: string;
  plan: DraftConsolidationPlan;
};

try {
  if (config.startedPath) writeFileSync(config.startedPath, "started\n");
  const result = applyDraftConsolidationPlan(config.plan, {
    ...config.options,
    onLockContention: config.blockedPath
      ? () => writeFileSync(config.blockedPath!, "blocked\n")
      : undefined,
    checkpoint: (point) => {
      if (point === config.crashAt) process.exit(73);
      if (point === config.holdAt && config.readyPath && config.releasePath) {
        writeFileSync(config.readyPath, `${point}\n`);
        while (!existsSync(config.releasePath)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
