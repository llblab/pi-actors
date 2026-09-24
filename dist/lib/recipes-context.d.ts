/**
 * Recipe context contracts and prompt assembly.
 * Zones: live session resolution, async runner prompt context, recipe provenance, LLM child launches
 * Owns the immutable live Recipe environment and compact actor context appended to child-agent prompts.
 */
import type { CommandTemplateActorRecipeContext } from "./command-templates.ts";
import * as RecipesReferences from "./recipes-references.ts";
import type { TemplateRecipeContextRecord } from "./recipes-references.ts";
export interface RecipeResolutionContext {
    readonly activeSkills: RecipesReferences.ActiveSkillRecipeContext;
    readonly cwd: string;
    readonly generation: string;
    readonly sessionId: string;
}
export declare function createRecipeResolutionContext(sessionId: string, cwd: string, activeSkills: RecipesReferences.ActiveSkillRecipeContext): RecipeResolutionContext;
export declare function createEmptyRecipeResolutionContext(sessionId: string, cwd: string): RecipeResolutionContext;
export interface MarkedRecipeContextRecord extends TemplateRecipeContextRecord {
    you_are_here?: true;
    you_are_here_path?: string;
}
export declare function findPiPrintPromptIndex(args: string[]): number | undefined;
export declare function markRecipeContextRecords(records: TemplateRecipeContextRecord[], context?: CommandTemplateActorRecipeContext): MarkedRecipeContextRecord[];
export declare function formatRecipeContextJsonl(records: TemplateRecipeContextRecord[], context?: CommandTemplateActorRecipeContext): string;
export declare function buildRecipeContextPromptBlock(records: TemplateRecipeContextRecord[], context?: CommandTemplateActorRecipeContext): string;
export declare function appendRecipeContextToPiArgs(command: string, args: string[], records: TemplateRecipeContextRecord[] | undefined, context?: CommandTemplateActorRecipeContext): string[];
export interface ManagedPiSessionArgs {
    args: string[];
    sessionDir?: string;
}
export declare function attachPiSessionDir(command: string, args: string[], sessionDir: string): ManagedPiSessionArgs;
export interface MaterializedPiPrintPromptArgs {
    args: string[];
    promptBytes?: number;
    promptFile?: string;
}
export declare function materializePiPrintPromptArg(command: string, args: string[], promptFile: string | (() => string)): MaterializedPiPrintPromptArgs;
