/**
 * Recipe Control contract.
 * Zones: actor-local action declarations, normalization, reserved-action fencing
 * Owns pure Recipe control validation; Recipe loading and Run capture stay in recipe/run domains.
 */

import * as Control from "./control.ts";
import * as Limits from "./limits.ts";

const RUNTIME_RUN_ACTIONS = new Set(["archive", "kill", "prune"]);

export function normalizeRecipeControl(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("recipe.control must be an array of action strings");
  }
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("recipe.control actions must be non-empty strings");
    }
    const action = raw.trim();
    if (!Control.isControlAction(action)) {
      throw new Error(`invalid recipe.control action: ${action}`);
    }
    if (action.length > Limits.CONTROL_ACTION_MAX_LENGTH) {
      throw new Error(
        `recipe.control action exceeds ${Limits.CONTROL_ACTION_MAX_LENGTH} ASCII characters: ${action}`,
      );
    }
    if (RUNTIME_RUN_ACTIONS.has(action)) {
      throw new Error(
        `recipe.control action is runtime-reserved and must not be declared: ${action}`,
      );
    }
    if (seen.has(action)) {
      throw new Error(`duplicate recipe.control action: ${action}`);
    }
    seen.add(action);
    actions.push(action);
  }
  return actions;
}

export function assertRecipeHasNoMailbox(recipe: Record<string, unknown>): void {
  if (Object.hasOwn(recipe, "mailbox")) {
    throw new Error(
      "recipe.mailbox was removed; replace it with control: [\"action\"] for actor-local inputs and emit Trace events for outputs",
    );
  }
}
