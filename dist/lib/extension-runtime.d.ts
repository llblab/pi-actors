/**
 * Pi actor extension runtime coordinator.
 * Zones: extension session lifecycle, host tool adaptation, runtime service composition
 * Owns low-level Pi lifecycle effects and tool wrapping without owning event registration.
 */
import * as Pi from "./pi.ts";
import * as RecipesReferences from "./recipes-references.ts";
export interface ActorExtensionRuntime {
    beforeAgentStart(systemPrompt: string, skills: RecipesReferences.ActiveSkillRecipeSource[], ctx: Pi.ExtensionContext): {
        systemPrompt: string;
    };
    discoverResources(metaUrl: string): {
        skillPaths: string[];
    } | undefined;
    getRunOwnerId(ctx: Pi.ExtensionContext): string;
    onAgentSettled(ctx: Pi.ExtensionContext): void;
    onContext(messages: unknown[], ctx: Pi.ExtensionContext): unknown[];
    onSessionShutdown(reason: string, ctx: Pi.ExtensionContext): void;
    onSessionStart(ctx: Pi.ExtensionContext): Promise<void>;
    registerCoreTools(): void;
}
export declare function createActorExtensionRuntime(pi: Pi.ExtensionAPI): ActorExtensionRuntime;
