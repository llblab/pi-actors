/**
 * Actor Inspector owned-Run evidence and actions.
 * Zones: owned inventory, captured Recipe reads, exact-session/generation action fencing
 * Owns Inspector domain operations; command/overlay wiring and lifecycle actuation stay in adapters.
 */
import { type RunRecipeView } from "./recipe-projection.ts";
export interface ActorInspectorRunItem {
    run: string;
    runInstanceId?: string;
    status: string;
    updatedAt?: string;
}
export declare function readActorInspectorRuns(stateRoot: string, ownerId: string): ActorInspectorRunItem[];
export declare function readActorInspectorRecipe(stateDir: string): RunRecipeView;
export interface ActorInspectorKillResult {
    ok: boolean;
    message: string;
}
export interface ActorInspectorKillDeps {
    getRunStatus: (runOrDir: string) => Record<string, unknown>;
    killRun: (runOrDir: string, expected: {
        ownerId: string;
        runInstanceId: string;
    }) => Record<string, unknown>;
}
/** Pure presentation of an already selected value; legacy metadata grants no source/privacy authority. */
export declare function formatActorInspectorKillFeedback(result: "rejected" | "unavailable" | "failed", selected: string, legacy?: {
    readonly clipped: boolean;
}): string;
export declare function killOwnedRunFromInspector(ownerId: string, run: string, stateRoot: string, expectedRunInstanceId: string, deps: ActorInspectorKillDeps): ActorInspectorKillResult;
