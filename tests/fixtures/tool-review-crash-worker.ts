import {
  applyToolReviewPlan,
  type ToolReviewTransactionCheckpoint,
} from "../../lib/tool-review-transaction.ts";

const [approvedPath, recipeRoot, crashAt] = process.argv.slice(2);
if (!approvedPath || !recipeRoot || !crashAt) process.exit(2);
applyToolReviewPlan(approvedPath, {
  checkpoint: (checkpoint) => {
    if (checkpoint === crashAt as ToolReviewTransactionCheckpoint) process.exit(74);
  },
  recipeRoot,
});
process.exit(0);
