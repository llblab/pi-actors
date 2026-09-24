/**
 * Command-template async run lifecycle facade.
 * Owns: launch, state observation, listing, message/control facade methods, and retention while runs-* subdomains own narrower run internals.
 */
import type { CommandTemplateFailureScope, CommandTemplateValue } from "./command-templates.ts";
import { type CurrentPolicyProvenance } from "./model-context.ts";
import * as RunDeliveryLineage from "./run-delivery-lineage.ts";
import * as RecipesReferences from "./recipes-references.ts";
import { type RunArtifactDeclaration } from "./runs-artifacts.ts";
import { type RunProcessIdentity } from "./runs-process.ts";
import * as RuntimeIdentity from "./runtime-identity.ts";
import * as RunsIndex from "./runs-index.ts";
import * as RunsParentTeardown from "./runs-parent-teardown.ts";
import { type DeliverRunControlOptions, type DeliverRunControlRequest } from "./runs-control-delivery.ts";
import { type AsyncRunStatus } from "./runs-status.ts";
export type AsyncRunLaunchSource = "spawn" | "tool";
export interface AsyncRunControlEndpoint {
    path: string;
    type: "fifo" | "named-pipe";
}
export declare function normalizeRunTransportContext(value: unknown): Record<string, string | number | boolean> | undefined;
export interface AsyncRunStartParams {
    async?: boolean;
    control_endpoint?: AsyncRunControlEndpoint;
    file?: string;
    launch_source?: AsyncRunLaunchSource;
    lifecycleHooks?: {
        onLockContention?(): void;
    };
    launch_correlation?: {
        correlation_id?: string;
        tool_call_id?: string;
    };
    name?: string;
    ownerId?: string;
    run_id?: string;
    singleton?: boolean;
    singleton_run_id?: string;
    singleton_recipe_id?: string;
    state_dir?: string;
    tool?: string;
    template?: CommandTemplateValue;
    args?: string[];
    defaults?: Record<string, unknown>;
    recipe_dir?: string;
    skill_dir?: string;
    parallel?: boolean;
    concurrency?: number | string;
    min_successful?: number | string;
    label?: string;
    when?: boolean | string;
    timeout?: number | string;
    delay?: number | string;
    accept_output?: "review_evidence";
    output?: string;
    artifacts?: Record<string, RunArtifactDeclaration>;
    control?: string[];
    notification_policy?: "normal" | "silent";
    retire_when?: "children_terminal";
    retry?: number | string;
    failure?: CommandTemplateFailureScope;
    recover?: CommandTemplateValue;
    transport_context?: Record<string, unknown>;
    repeat?: number;
    values?: Record<string, unknown>;
    policy_values?: Record<string, unknown>;
    actor_context?: boolean | string;
    cwd?: string;
}
export type { AsyncRunStatus } from "./runs-status.ts";
export interface AsyncRunMeta {
    argv: string[];
    createdAt: string;
    cwd: string;
    launch_kind?: AsyncRunLaunchSource;
    launch_source?: AsyncRunLaunchSource;
    launch_correlation?: {
        correlation_id?: string;
        tool_call_id?: string;
    };
    ownerId?: string;
    pid: number;
    recipe?: string;
    recipe_file?: string;
    run: string;
    run_instance_id: string;
    state_dir: string;
    state_schema: typeof RuntimeIdentity.RUN_STATE_SCHEMA;
    status: AsyncRunStatus;
    tool?: string;
    template: CommandTemplateValue;
    values: Record<string, unknown>;
    artifacts?: Record<string, RunArtifactDeclaration>;
    control?: string[];
    control_endpoint?: AsyncRunControlEndpoint;
    delivery_owner_id?: string;
    delivery_parent?: RunDeliveryLineage.RunDeliveryParent;
    model_policy?: CurrentPolicyProvenance;
    notification_policy?: "normal" | "silent";
    process_identity?: RunProcessIdentity;
    recipe_context_records?: RecipesReferences.TemplateRecipeContextRecord[];
    retire_when?: "children_terminal";
    reused?: boolean;
    singleton?: boolean;
    singleton_recipe_id?: string;
    singleton_values?: Record<string, unknown>;
    transport_context?: Record<string, unknown>;
}
export { safeRunId } from "./runs-identity.ts";
export { resolveArtifactManifest } from "./runs-artifacts.ts";
export type { RunArtifactDeclaration, RunArtifactManifestEntry, } from "./runs-artifacts.ts";
export interface AsyncRunStartOptions {
    skillContext?: RecipesReferences.ActiveSkillRecipeContext;
}
export declare function startRun(params: AsyncRunStartParams, cwd: string, options?: AsyncRunStartOptions): AsyncRunMeta;
export declare function getRunStatus(runOrDir: string): Record<string, unknown>;
export type { RunStateIndexEntry } from "./runs-index.ts";
export declare function listRunStateDirs(stateRoot?: string): string[];
export declare function rebuildRunStateIndex(stateRoot?: string): RunsIndex.RunStateIndexEntry[];
export declare function readRunStateIndex(stateRoot?: string): RunsIndex.RunStateIndexEntry[] | undefined;
export declare function listRuns(stateRoot?: string, statusFilter?: string): Array<Record<string, unknown>>;
export type { ParentRunTeardownAttempt, ParentRunTeardownDiscoveryFailure, ParentRunTeardownResult, } from "./runs-parent-teardown.ts";
export interface ParentRunsTeardownSummaryResult extends RunsParentTeardown.ParentRunTeardownResult {
    summaryPath?: string;
}
export declare function teardownRunsOwnedByParent(ownerId: string | undefined, stateRoot?: string, options?: {
    trigger?: string;
}): ParentRunsTeardownSummaryResult;
export declare function tailRun(runOrDir: string, lines?: number): string;
export type { DeliverRunControlOptions, DeliverRunControlRequest, } from "./runs-control-delivery.ts";
export interface SendRunControlOptions extends DeliverRunControlOptions {
    ownerId?: string;
}
export declare function sendRunControl(runOrDir: string, request: DeliverRunControlRequest, options?: SendRunControlOptions): Promise<Record<string, unknown>>;
export { getRunProcessSignalPlan } from "./runs-control.ts";
export type { RunProcessSignalPlan } from "./runs-control.ts";
export interface RunControlExpectation {
    onLocked?(): void;
    ownerId?: string;
    runInstanceId?: string;
}
export declare function markRunTerminalNotificationHandled(stateDir: string, status: string, expectedRunInstanceId: string): boolean;
export declare function markRunSteerPresentationHandled(stateDir: string, expectedRunInstanceId: string, eventId: string, steerId: string): boolean;
export declare function cancelRun(runOrDir: string, expected?: RunControlExpectation): Record<string, unknown>;
export declare function archiveRun(runOrDir: string, expected?: RunControlExpectation): Record<string, unknown>;
export declare function pruneRun(runOrDir: string, options?: {
    preserveArtifacts?: boolean;
}, expected?: RunControlExpectation): Record<string, unknown>;
export declare function killRun(runOrDir: string, expected?: RunControlExpectation): Record<string, unknown>;
