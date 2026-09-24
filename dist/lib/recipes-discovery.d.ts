/**
 * File-discovered recipe registry helpers
 * Zones: recipe discovery, tool exposure, registry diagnostics
 * Owns filename identity discovery across prioritized recipe roots
 */
import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import type { RecipeResolutionContext } from "./recipes-context.ts";
import type { TemplateRecipeConfig } from "./recipes-references.ts";
export interface DiscoveredRecipe {
    id: string;
    path: string;
    root: string;
    priority: number;
    config?: TemplateRecipeConfig;
    active: boolean;
    shadowed: boolean;
    invalid: boolean;
    disabled: boolean;
    tool: boolean;
    mutableUsage: boolean;
    resolutionContext?: RecipeResolutionContext;
    diagnostics: string[];
    riskLabels: CommandTemplates.CommandTemplateRiskLabel[];
    shadows: string[];
}
export interface RecipeIntegrityManifestEntry {
    id: string;
    path: string;
    root: string;
    sha256: string;
    size: number;
    tool: boolean;
    active: boolean;
    invalid: boolean;
    disabled: boolean;
    shadowed: boolean;
}
export interface RecipesDiscoveryResult {
    active: Map<string, DiscoveredRecipe>;
    entries: DiscoveredRecipe[];
    diagnostics: string[];
}
export interface RecipesDiscoverySource {
    root?: string;
    file?: string;
    defaultTool?: boolean;
    mutableUsage?: boolean;
    resolutionContext?: RecipeResolutionContext;
}
export interface UserRecipeAdmission {
    args?: string[];
    argTypes?: RegisteredTool["argTypes"];
    artifacts?: Record<string, string>;
    async?: boolean;
    control?: string[];
    defaults?: Record<string, unknown>;
    diagnostics: string[];
    effectiveRecipe?: TemplateRecipeConfig;
    identity: string;
    sourcePath: string;
    tool?: RegisteredTool;
    validated: boolean;
}
export declare function hasBroadWindowsWriteAcl(icaclsOutput: string): boolean;
export declare function discoverRecipeSources(sources: RecipesDiscoverySource[]): RecipesDiscoveryResult;
export declare function discoverRecipes(roots: string[]): RecipesDiscoveryResult;
export declare function createRecipeIntegrityManifest(result: RecipesDiscoveryResult): RecipeIntegrityManifestEntry[];
export declare function getShadowedLaunchDiagnostic(result: RecipesDiscoveryResult, id: string): Record<string, unknown> | undefined;
export declare function listDraftRecipes(root: string): Array<Record<string, unknown>>;
export declare function summarizeDiscovery(result: RecipesDiscoveryResult): Record<string, unknown>;
export declare function summarizeRegisteredToolArgs(tool: RegisteredTool): {
    optional: string[];
    required: string[];
};
export declare function admitUserRecipe(sourcePath: string, resolutionContext: RecipeResolutionContext, authoredRecipe?: Record<string, unknown>, mutableUsage?: boolean): UserRecipeAdmission;
export declare function toRegisteredTool(entry: DiscoveredRecipe): RegisteredTool | undefined;
