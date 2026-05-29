/**
 * Prompt and schema copy helpers
 * Zones: prompts, onboarding, tool schema copy
 * Owns LLM-facing descriptions, prompt snippets, guidelines, and parameter descriptions
 */

export const REGISTER_TOOL_DESCRIPTION =
  "Register a persistent custom tool from a command template, template recipe path, or co-located template recipe. " +
  "Definitions are stored as recipe files under ~/.pi/agent/recipes across reloads. " +
  "Use update=true to overwrite an existing tool, template=null/empty to delete.";

export const REGISTER_TOOL_PROMPT_SNIPPET =
  "Register persistent command templates as agent-callable tools";

export const REGISTER_TOOL_GUIDELINES = [
  "Use register_tool to wrap trusted local commands, scripts, programs, libraries, or template recipes as persistent pi tools.",
  "After register_tool succeeds, the new tool is immediately callable and remains available after reload.",
  'Set template=null or template="" in register_tool to delete a persisted tool.',
  "Set update=true in register_tool to overwrite an existing tool registration.",
];

export const ONBOARDING_SYSTEM_PROMPT = `pi-actors quick model:
- Local-first actor memory: persist trusted local capabilities instead of rebuilding shell recipes.
- Layers: task -> command template -> recipe/tool -> spawn -> run:<id>; tool:<name> wraps registered capabilities.
- Command templates stay sync: string leaf, array sequence, object node; flags include args/defaults, parallel, when, timeout, delay, retry, failure, recover, repeat, output.
- Placeholders support typed/default args plus {value??fallback} and {flag?yes:no}.
- ~/.pi/agent/recipes/*.json is actor muscle memory: every recipe there is auto-registered as an agent tool across sessions; register_tool writes there.
- Recipes own template directly and may declare metadata/defaults/imports/mailbox/artifacts; files >1 MiB or import depth >32 fail closed.
- Recipe imports are local variables; imported recipes are definitions, not nested async runs; parent async:true creates one run.
- Actor-mode trigger: if work may outlive this turn, need steering/follow-up/artifacts, run as a service, fan out, or be resumed/inspected later, use spawn -> message -> inspect instead of ad hoc shell backgrounding.
- Use spawn/message/inspect for actor-level start/send/observe; short foreground checks can stay ordinary tools/templates; avoid runtime/FIFO/outbox vocabulary in public guidance.
- Run state lives under ~/.pi/agent/tmp/pi-actors/runs; inspect status/tail/messages/mailbox/files/artifacts intentionally and avoid busy-polling.
- Maintain ~/.pi/agent/recipes like MEMORY.md for capabilities: keep useful tools, curate stale ones, and fix/remove/disable invalid recipes flagged by registry warnings; packaged/ad hoc recipes are lower-priority components; offer to save successful recurring patterns only after confirmation.
- Long fanout = parent async recipe wrapping template(parallel:true) and imports; packaged fanout recipes bubble branch completion messages; grow recurring multi-agent workflows as packaged recipes/pipelines, not ad hoc external scripts.
- For any non-trivial actor use or pi-actors change, read the bundled actors skill first; for deeper guidance, inspect installed extension sources/docs/recipes because README/docs are not automatically in context.`;

export const REGISTER_TOOL_PARAM_DESCRIPTIONS = {
  name: "Tool name in snake_case (e.g., 'transcribe')",
  description:
    "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.",
  draft:
    "Promote a draft recipe path from ~/.pi/agent/recipes/drafts into an active named recipe under ~/.pi/agent/recipes. Requires name; use update=true to overwrite.",
  async:
    "Set true for a co-located async template recipe. Omit for ordinary command templates or file-backed recipe references.",
  state_dir:
    "Optional async run state directory for a co-located template recipe.",
  template:
    "Command template with {arg} or {arg=default} placeholders, or a template recipe JSON path/name. With async, this is the co-located recipe body. Bare recipe names resolve under ~/.pi/agent/recipes. Omitted updates keep the old template. Empty string deletes the tool.",
  templateArray:
    "Sequential command-template composition array. Leaves may be strings or objects with template/defaults/timeout/retry/failure/recover.",
  templateNull: "Delete the tool when template is null.",
  args: "Optional comma-separated placeholder declarations. Usually omit because args are derived from template placeholders. Interactive shorthand defaults are accepted and normalized. Example: file,lang,mode=fast",
  update: "Set to true to overwrite an existing tool registration.",
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
