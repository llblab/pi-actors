/**
 * Prompt and schema copy helpers
 * Zones: prompts, onboarding, tool schema copy
 * Owns LLM-facing descriptions, prompt snippets, guidelines, and parameter descriptions
 */
export declare const REGISTER_TOOL_DESCRIPTION: string;
export declare const REGISTER_TOOL_PROMPT_SNIPPET = "Register persistent Recipes or command templates as agent-callable tools";
export declare const REGISTER_TOOL_GUIDELINES: string[];
export declare const ONBOARDING_SYSTEM_PROMPT = "pi-actors Skill routing:\n- Treat active bundled Skills as the operating authority.\n- For non-trivial pi-actors operation, diagnosis, or development, load and read the actors Skill before acting.\n- For work requiring multiple actors or subagents, additionally load and read the swarm Skill.\n- For capability-specific selection or constraints, load the owning capability Skill; actors owns generic mechanics and swarm owns multi-actor methodology.\n- Keep a Skill Recipe distinct from a registered tool and a Recipe spawn distinct from registered-tool invocation; actors owns the proof rules.\n- Treat persistence or registration as distinct from current callability; actors owns activation proof.\n- On failure or disagreement, preserve the logical Recipe identity, stop, and follow actors diagnosis; never bypass the owning Skills with copied contracts, helper paths, shell evaluation, or background-process workarounds.\n- If a capability Skill conflicts with actors about generic mechanics, follow actors and report the stale capability guidance.\n- README and docs are human-facing references, not the normal agent operating path.\n- AGENTS, source, and tests are implementation protocol and evidence; use them when changing or debugging the extension, not as substitutes for operating Skills.";
export declare const REGISTER_TOOL_PARAM_DESCRIPTIONS: {
    readonly name: "Tool name in snake_case (e.g., 'transcribe')";
    readonly description: "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.";
    readonly from: "Recipe to specialize by canonical <skill>/<recipe> identity or explicit .json/.md path. Inherits async, args/types, source defaults, artifacts, Control, and runtime origins.";
    readonly defaults: "Optional caller-owned defaults. Keys and values must satisfy the effective source or command-template argument contract.";
    readonly draft: "Promote a captured draft Recipe path from ~/.pi/agent/recipes/drafts. This is a source mode; do not combine it with from or template.";
    readonly async: "Set true for a co-located async template recipe. Omit for ordinary command templates or file-backed recipe references.";
    readonly template: "Trusted command template with {arg} or {arg=default} placeholders. To specialize a Recipe, use from instead. Omitted updates keep the old template; empty string deletes the tool.";
    readonly templateArray: "Sequential command-template composition array. Leaves may be strings or objects with template/defaults/timeout/retry/failure/recover.";
    readonly templateNull: "Delete the tool when template is null.";
    readonly args: "Optional comma-separated placeholder declarations. Usually omit because args are derived from template placeholders. Interactive shorthand defaults are accepted and normalized. Example: file,lang,mode=fast";
    readonly update: "Set to true to overwrite an existing tool registration.";
};
export declare function formatRegisteredToolPromptSnippet(template: unknown): string;
export declare function formatRecipeToolPromptSnippet(recipe: string, asyncRecipe: boolean): string;
