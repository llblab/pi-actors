/**
 * Prompt and schema copy helpers
 * Owns LLM-facing descriptions, prompt snippets, guidelines, and parameter descriptions
 */

export const REGISTER_TOOL_DESCRIPTION =
  "Register a persistent custom tool from a command template. " +
  "Definitions are stored in auto-tools.json across reloads. " +
  "Use update=true to overwrite an existing auto-tool, template=null/empty to delete.";

export const REGISTER_TOOL_PROMPT_SNIPPET =
  "Register persistent command templates as agent-callable tools";

export const REGISTER_TOOL_GUIDELINES = [
  "Use register_tool to wrap trusted local commands, scripts, programs, or libraries as persistent pi tools.",
  "After register_tool succeeds, the new tool is immediately callable and remains available after reload.",
  'Set template=null or template="" in register_tool to delete a persisted auto-tool.',
  "Set update=true in register_tool to overwrite an existing auto-tool registration.",
];

export const REGISTER_TOOL_PARAM_DESCRIPTIONS = {
  name: "Tool name in snake_case (e.g., 'transcribe')",
  label: "Human-readable label (e.g., 'Transcribe Audio')",
  description:
    "Describe what the tool does for the LLM. Required unless deleting; omitted updates keep the old description.",
  template:
    "Command template with {arg} placeholders. Omitted updates keep the old template. Empty string deletes the tool.",
  templateNull: "Delete the tool when template is null.",
  args: "Comma-separated argument names with optional defaults. Omitted updates keep old args; empty string clears args. Example: file,lang,model=openai-codex/gpt-5.5",
  update: "Set to true to overwrite an existing auto-tool registration.",
} as const;

export function formatRegisteredToolPromptSnippet(template: string): string {
  return `Execute command template: ${template}`;
}
