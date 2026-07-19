import { existsSync, writeFileSync } from "node:fs";

import { applyApprovedToolReviewAtSessionBoundary } from "../../lib/tool-review-scheduler.ts";

const [statePath, recipeRoot, outputPath, readyPath, proceedPath] = process.argv.slice(2);
if (!statePath || !recipeRoot || !outputPath) process.exit(2);
const result = applyApprovedToolReviewAtSessionBoundary({
  ...(readyPath && proceedPath
    ? {
        lifecycleHooks: {
          onStateLocked: () => {
            writeFileSync(readyPath, "ready\n", "utf8");
            while (!existsSync(proceedPath)) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          },
        },
      }
    : {}),
  recipeRoot,
  statePath,
});
writeFileSync(outputPath, `${JSON.stringify(result)}\n`, "utf8");
