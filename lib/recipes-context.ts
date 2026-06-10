/**
 * Recipe context prompt assembly.
 * Zones: async runner prompt context, recipe provenance, LLM child launches
 * Owns compact actor recipe context records appended to child-agent prompts.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";

import type { CommandTemplateActorRecipeContext } from "./command-templates.ts";
import type { TemplateRecipeContextRecord } from "./recipes-references.ts";

export interface MarkedRecipeContextRecord extends TemplateRecipeContextRecord {
  you_are_here?: true;
  you_are_here_path?: string;
}

function commandName(command: string): string {
  return basename(command).toLowerCase();
}

function isPiCommand(command: string): boolean {
  return commandName(command) === "pi";
}

const PI_PRINT_FLAGS = new Set(["-p", "--print"]);
const PI_VALUE_OPTIONS = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "--extension",
  "--fork",
  "--mode",
  "--model",
  "--models",
  "--name",
  "--prompt-template",
  "--provider",
  "--session",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
]);
const PI_SHORT_VALUE_OPTIONS = new Set(["-e", "-n", "-t", "-xt"]);

function isPiPrintFlag(arg: string): boolean {
  return PI_PRINT_FLAGS.has(arg);
}

function isPiOption(arg: string): boolean {
  return arg.startsWith("-") && arg !== "-";
}

function piOptionConsumesNextArg(arg: string): boolean {
  if (arg.includes("=")) return false;
  return PI_VALUE_OPTIONS.has(arg) || PI_SHORT_VALUE_OPTIONS.has(arg);
}

function isPiFileArgument(arg: string): boolean {
  return arg.startsWith("@") && arg.length > 1;
}

export function findPiPrintPromptIndex(args: string[]): number | undefined {
  let printMode = false;
  let positionalOnly = false;
  let promptIndex: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && isPiPrintFlag(arg)) {
      printMode = true;
      continue;
    }
    if (!positionalOnly && isPiOption(arg)) {
      if (piOptionConsumesNextArg(arg)) index += 1;
      continue;
    }
    if (!printMode || isPiFileArgument(arg)) continue;
    promptIndex = index;
  }
  return promptIndex;
}

function matchesActorContext(
  record: TemplateRecipeContextRecord,
  context: CommandTemplateActorRecipeContext | undefined,
): boolean {
  if (!context) return record.role === "entry";
  if (context.file && context.file === record.file) return true;
  if (context.name && context.name === record.name) return true;
  if (context.alias && context.alias === record.alias) return true;
  return false;
}

function contextPath(
  record: TemplateRecipeContextRecord,
  context: CommandTemplateActorRecipeContext | undefined,
): string {
  return record.import_path.join(".") || context?.path || record.name;
}

export function markRecipeContextRecords(
  records: TemplateRecipeContextRecord[],
  context?: CommandTemplateActorRecipeContext,
): MarkedRecipeContextRecord[] {
  let marked = false;
  const result = records.map((record) => {
    if (marked || !matchesActorContext(record, context)) return record;
    marked = true;
    return {
      ...record,
      you_are_here: true as const,
      you_are_here_path: contextPath(record, context),
    };
  });
  return result;
}

export function formatRecipeContextJsonl(
  records: TemplateRecipeContextRecord[],
  context?: CommandTemplateActorRecipeContext,
): string {
  return markRecipeContextRecords(records, context)
    .map((record) => JSON.stringify(record))
    .join("\n");
}

export function buildRecipeContextPromptBlock(
  records: TemplateRecipeContextRecord[],
  context?: CommandTemplateActorRecipeContext,
): string {
  const jsonl = formatRecipeContextJsonl(records, context);
  if (!jsonl) return "";
  return [
    "Actor recipe context bundle follows as JSONL.",
    'Each line is one recipe/context record; `"you_are_here": true` marks the recipe node that launched this actor.',
    "Use this as workflow/composition context, while the task prompt remains authoritative.",
    "```jsonl",
    jsonl,
    "```",
  ].join("\n");
}

export function appendRecipeContextToPiArgs(
  command: string,
  args: string[],
  records: TemplateRecipeContextRecord[] | undefined,
  context?: CommandTemplateActorRecipeContext,
): string[] {
  if (!records || records.length === 0 || !isPiCommand(command)) return args;
  const promptIndex = findPiPrintPromptIndex(args);
  if (promptIndex === undefined) return args;
  const block = buildRecipeContextPromptBlock(records, context);
  if (!block) return args;
  const next = [...args];
  next[promptIndex] = `${next[promptIndex]}\n\n${block}`;
  return next;
}

export interface MaterializedPiPrintPromptArgs {
  args: string[];
  promptBytes?: number;
  promptFile?: string;
}

export function materializePiPrintPromptArg(
  command: string,
  args: string[],
  promptFile: string | (() => string),
): MaterializedPiPrintPromptArgs {
  if (!isPiCommand(command)) return { args };
  const promptIndex = findPiPrintPromptIndex(args);
  if (promptIndex === undefined) return { args };
  const prompt = args[promptIndex];
  const path = typeof promptFile === "function" ? promptFile() : promptFile;
  writeFileSync(path, prompt, "utf8");
  const next = [...args];
  next[promptIndex] = `@${path}`;
  return {
    args: next,
    promptBytes: Buffer.byteLength(prompt),
    promptFile: path,
  };
}
