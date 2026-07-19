import { applyApprovedToolReviewAtSessionBoundary } from "../../lib/tool-review-scheduler.ts";

const [statePath, recipeRoot, crashAt] = process.argv.slice(2);
if (!statePath || !recipeRoot || !crashAt) process.exit(2);
applyApprovedToolReviewAtSessionBoundary({
  lifecycleHooks: {
    onCompleted: () => {
      if (crashAt === "completed") process.exit(76);
    },
    onLineagePending: () => {
      if (crashAt === "lineage_pending") process.exit(76);
    },
  },
  recipeRoot,
  statePath,
});
process.exit(0);
