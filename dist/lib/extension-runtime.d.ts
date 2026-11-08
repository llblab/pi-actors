/**
 * Pi actor extension runtime coordinator.
 * Zones: extension session lifecycle, host tool adaptation, runtime service composition
 * Owns low-level Pi lifecycle effects and tool wrapping without owning event registration.
 */
import * as Pi from "./pi.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RunUiRuntime from "./run-ui-runtime.ts";
import { type RunSupervisionOwnerSnapshotReading } from "./runs-supervision.ts";
import type { RunSupervisionControllerPorts } from "./run-supervision.ts";
import type { AsyncRunStartOptions } from "./async-runs.ts";
export interface ActorExtensionRuntime {
    beforeAgentStart(systemPrompt: string, skills: RecipesReferences.ActiveSkillRecipeSource[], ctx: Pi.ExtensionContext): {
        systemPrompt: string;
    };
    discoverResources(metaUrl: string): {
        skillPaths: string[];
    } | undefined;
    getRunOwnerId(ctx: Pi.ExtensionContext): string;
    onAgentSettled(ctx: Pi.ExtensionContext): void;
    onTurnEnd(event: Pi.TurnEndEvent, ctx: Pi.ExtensionContext): Pi.TurnEndEventResult | undefined;
    onContext(messages: unknown[], ctx: Pi.ExtensionContext): unknown[];
    onSessionShutdown(reason: string, ctx: Pi.ExtensionContext): void;
    onSessionStart(ctx: Pi.ExtensionContext, event?: Pi.SessionStartEvent): Promise<void>;
    registerCoreTools(): void;
    /** Private kernel observation only; no public tool route or reconstructed origin. */
    observeRunSnapshot(expected: unknown, capturedAt: unknown, stateDir?: string): Readonly<RunSupervisionOwnerSnapshotReading>;
    getRunAdmissionObserver(ctx: Pi.ExtensionContext): AsyncRunStartOptions["onSupervisionClockCaptured"];
}
export declare function createActorExtensionRuntime(pi: Pi.ExtensionAPI, supervisionPorts?: Omit<RunSupervisionControllerPorts, "readCurrent">, completionStreamSessionAdmission?: RunUiRuntime.RunUiRuntimeDeps["completionStreamSessionAdmission"], captureCompletionBatch?: RunUiRuntime.RunUiRuntimeDeps["captureCompletionBatch"]): ActorExtensionRuntime;
