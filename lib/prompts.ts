/**
 * Prompt and schema copy helpers
 * Zones: prompts, onboarding, tool schema copy
 * Owns LLM-facing descriptions, prompt snippets, guidelines, and parameter descriptions
 */

export const REGISTER_TOOL_DESCRIPTION =
  "Register a persistent custom tool from a command template, template recipe path, or co-located template recipe. " +
  "Definitions are stored in auto-tools.json across reloads. " +
  "Use update=true to overwrite an existing auto-tool, template=null/empty to delete.";

export const REGISTER_TOOL_PROMPT_SNIPPET =
  "Register persistent command templates as agent-callable tools";

export const REGISTER_TOOL_GUIDELINES = [
  "Use register_tool to wrap trusted local commands, scripts, programs, libraries, or template recipes as persistent pi tools.",
  "After register_tool succeeds, the new tool is immediately callable and remains available after reload.",
  'Set template=null or template="" in register_tool to delete a persisted auto-tool.',
  "Set update=true in register_tool to overwrite an existing auto-tool registration.",
];

export const ONBOARDING_SYSTEM_PROMPT = `pi-auto-tools quick model:
- Local-first cybernetic tool memory: agents persist trusted local capabilities instead of repeating shell recipes.
- Task = user work; template = execution graph; recipe = saved JSON; run = execution instance.
- Command templates stay sync: string leaf, array sequence, object flags, parallel: true fanout.
- Template flags: args/defaults, parallel, when, timeout, delay, retry, failure, recover, repeat, output; placeholders support {value??fallback} and {flag?yes:no}.
- Recipes live in ~/.pi/agent/recipes/*.json and wrap templates with metadata/defaults/imports/artifacts.
- Recipe imports are local variables: imports.alias -> {"name":"alias"} nodes and {alias.defaults.key} refs.
- Imported recipes are definitions, not nested async runs; parent async:true creates one run.
- async:true = detached lifecycle; spawn creates run actors from recipes/templates.
- Async run state lives under ~/.pi/agent/tmp/pi-auto-tools/runs.
- Use spawn/message/inspect for actor-level start/send/observe; runtime action internals are absorbed into the actor API.
- Run lifecycle = state files, logs, actor messages, mailbox send, cancel/kill, compact status; do not busy-poll runs, rely on message/follow-up notifications and use message for explicit run-local commands.
- Tool template may be a command template, recipe path/name, or co-located recipe.
- register_tool makes compact persistent buttons; args may be typed or derived from placeholders.
- For single calls or short pipelines, use foreground templates/tools.
- For subagents, swarms, background music, or long fanout, prefer async recipes/runs.
- Long async fanout = parent async recipe wrapping template(parallel: true) and imports; packaged fanout recipes bubble branch completion follow-ups by default.
- If asked to explore pi-auto-tools, read README.md, docs/README.md, docs/template-recipes.md, docs/async-runs.md, and recipes/.
- Ambient triangles show active async commands/subagents for the launching coordinator.
- After async run finish, inspect status/tail/events before final artifacts.`;

export const REGISTER_TOOL_PARAM_DESCRIPTIONS = {
  name: "Tool name in snake_case (e.g., 'transcribe')",
  description:
    "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.",
  async:
    "Set true for a co-located async template recipe. Omit for ordinary command templates or file-backed recipe references.",
  state_dir:
    "Optional async run state directory for a co-located template recipe.",
  template:
    "Command template with {arg} or {arg=default} placeholders, or a template recipe JSON path/name. With async, this is the co-located recipe body. Bare recipe names resolve under ~/.pi/agent/recipes. Omitted updates keep the old template. Empty string deletes the tool.",
  templateArray:
    "Sequential command-template composition array. Leaves may be strings or objects with template/defaults/timeout/retry/failure/recover.",
  templateNull: "Delete the tool when template is null.",
  args: "Optional comma-separated placeholder declarations. Usually omit because args are derived from template placeholders. Interactive shorthand defaults are accepted and normalized. Example: file,lang,model=openai-codex/gpt-5.5",
  update: "Set to true to overwrite an existing auto-tool registration.",
  values:
    "Optional default runtime placeholder values for a co-located template recipe.",
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
