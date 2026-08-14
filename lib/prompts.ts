/**
 * Prompt and schema copy helpers
 * Zones: prompts, onboarding, tool schema copy
 * Owns LLM-facing descriptions, prompt snippets, guidelines, and parameter descriptions
 */

export const REGISTER_TOOL_DESCRIPTION =
  "Register a persistent custom tool from one maintained Recipe, command template, or captured draft. " +
  "Use from for Recipe specialization, template for trusted commands, or draft for promotion. " +
  "Definitions persist under ~/.pi/agent/recipes; activation is reported separately.";

export const REGISTER_TOOL_PROMPT_SNIPPET =
  "Register persistent Recipes or command templates as agent-callable tools";

export const REGISTER_TOOL_GUIDELINES = [
  "Use register_tool from=<skill>/<recipe> with defaults={...} to specialize a maintained Recipe without copying its contract.",
  "Use register_tool template only for trusted command templates, and use register_tool draft only for captured draft promotion.",
  "After register_tool succeeds, trust its callable_now and activation result; persistence alone is not callability.",
  'Set template=null or template="" in register_tool to delete a persisted tool.',
  "Set update=true in register_tool to overwrite an existing tool registration.",
];

export const ONBOARDING_SYSTEM_PROMPT = `pi-actors Skill routing:
- Treat active bundled Skills as the operating authority.
- For non-trivial pi-actors operation, diagnosis, or development, load and read the actors Skill before acting.
- For work requiring multiple actors or subagents, additionally load and read the swarm Skill.
- For capability-specific selection or constraints, load the owning capability Skill; actors owns generic mechanics and swarm owns multi-actor methodology.
- Keep a Skill Recipe distinct from a registered tool and a Recipe spawn distinct from registered-tool invocation; actors owns the proof rules.
- Treat persistence or registration as distinct from current callability; actors owns activation proof.
- On failure or disagreement, preserve the logical Recipe identity, stop, and follow actors diagnosis; never bypass the owning Skills with copied contracts, helper paths, shell evaluation, or background-process workarounds.
- If a capability Skill conflicts with actors about generic mechanics, follow actors and report the stale capability guidance.
- README and docs are human-facing references, not the normal agent operating path.
- AGENTS, source, and tests are implementation protocol and evidence; use them when changing or debugging the extension, not as substitutes for operating Skills.`;

export const REGISTER_TOOL_PARAM_DESCRIPTIONS = {
  name: "Tool name in snake_case (e.g., 'transcribe')",
  description:
    "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.",
  from:
    "Recipe to specialize by canonical <skill>/<recipe> identity or explicit .json/.md path. Inherits async, args/types, source defaults, artifacts, Control, and runtime origins.",
  defaults:
    "Optional caller-owned defaults. Keys and values must satisfy the effective source or command-template argument contract.",
  draft:
    "Promote a captured draft Recipe path from ~/.pi/agent/recipes/drafts. This is a source mode; do not combine it with from or template.",
  async:
    "Set true for a co-located async template recipe. Omit for ordinary command templates or file-backed recipe references.",
  template:
    "Trusted command template with {arg} or {arg=default} placeholders. To specialize a Recipe, use from instead. Omitted updates keep the old template; empty string deletes the tool.",
  templateArray:
    "Sequential command-template composition array. Leaves may be strings or objects with template/defaults/timeout/retry/failure/recover.",
  templateNull: "Delete the tool when template is null.",
  args: "Optional comma-separated placeholder declarations. Usually omit because args are derived from template placeholders. Interactive shorthand defaults are accepted and normalized. Example: file,lang,mode=fast",
  update: "Set to true to overwrite an existing tool registration.",
} as const;

export function formatRegisteredToolPromptSnippet(template: unknown): string {
  const rendered =
    typeof template === "string" ? template : JSON.stringify(template);
  return `Execute command template: ${rendered}`;
}

export function formatRecipeToolPromptSnippet(
  recipe: string,
  asyncRecipe: boolean,
): string {
  return asyncRecipe
    ? `Start async template recipe: ${recipe}`
    : `Execute template recipe: ${recipe}`;
}
