/**
 * Command-template helpers
 * Owns split-first command-template parsing, placeholder substitution, and command path expansion
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

export interface TemplateInvocation {
  command?: string;
  args: string[];
}

export function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let active = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      active = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (active) words.push(current);
      if (active) current = "";
      active = false;
      continue;
    }
    current += char;
    active = true;
  }
  if (escaped) current += "\\";
  if (active || current) words.push(current);
  return words;
}

export function getTemplateArgValue(
  arg: string,
  params: Record<string, unknown>,
  defaults: Record<string, string>,
): string {
  return params[arg] === undefined ? (defaults[arg] ?? "") : String(params[arg]);
}

export function substituteTemplateToken(
  token: string,
  params: Record<string, unknown>,
  args: string[],
  defaults: Record<string, string>,
): string {
  let result = token;
  for (const arg of args) {
    result = result.replaceAll(
      `{${arg}}`,
      getTemplateArgValue(arg, params, defaults),
    );
  }
  return result;
}

export function buildTemplateInvocation(
  template: string,
  params: Record<string, unknown>,
  args: string[],
  defaults: Record<string, string>,
): TemplateInvocation {
  const parts = splitShellWords(template).map((part) =>
    substituteTemplateToken(part, params, args, defaults),
  );
  return { command: parts[0], args: parts.slice(1) };
}

export function resolveTemplateCommand(command: string): string {
  if (command === "~") return homedir();
  if (command.startsWith("~/")) return resolve(homedir(), command.slice(2));
  return command;
}
