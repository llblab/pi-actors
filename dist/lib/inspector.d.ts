/**
 * Actor Inspector evidence readers.
 * Zones: owned actor-instance inventory and captured Recipe projection
 * Owns actor-instance TUI evidence; Trace, Control, and execution parsing stay in their domains.
 */
export interface ActorInspectorRunItem {
    run: string;
    runInstanceId?: string;
    status: string;
    updatedAt?: string;
}
export declare function readActorInspectorRuns(stateRoot: string, ownerId: string): ActorInspectorRunItem[];
export interface ActorInspectorRecipeView {
    composition: Array<Record<string, unknown>>;
    definition?: Record<string, unknown>;
    diagnostics: string[];
    identity: Record<string, unknown>;
    launch: Record<string, unknown>;
}
export declare function readActorInspectorRecipe(stateDir: string): ActorInspectorRecipeView;
