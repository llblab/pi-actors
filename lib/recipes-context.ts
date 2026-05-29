/**
 * Recipe context prompt assembly.
 * Zones: async runner prompt context, recipe provenance, LLM child launches
 * Owns compact actor recipe context records appended to child-agent prompts.
 */

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

function findPrintPromptIndex(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "-p" || arg === "--print") && index + 1 < args.length) {
      return index + 1;
    }
  }
  return undefined;
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
  const promptIndex = findPrintPromptIndex(args);
  if (promptIndex === undefined) return args;
  const block = buildRecipeContextPromptBlock(records, context);
  if (!block) return args;
  const next = [...args];
  next[promptIndex] = `${next[promptIndex]}\n\n${block}`;
  return next;
}
