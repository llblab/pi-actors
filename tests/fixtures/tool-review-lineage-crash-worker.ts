import { finalizeToolReviewLineage } from "../../lib/tool-review-lineage-transaction.ts";

const [approvedPath, recipeRoot] = process.argv.slice(2);
if (!approvedPath || !recipeRoot) process.exit(2);
finalizeToolReviewLineage(approvedPath, {
  checkpoint: (checkpoint) => {
    if (checkpoint === "ledger_written") process.exit(75);
  },
  recipeRoot,
});
process.exit(0);
