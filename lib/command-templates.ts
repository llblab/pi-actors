/**
 * Command-template standard helpers
 * Zones: shared utils, local process execution, automation standard
 * Owns shell-free command-template splitting, placeholder defaults, composition expansion, executable path expansion, and direct execution
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type CommandTemplateMode = "sequence" | "parallel";

export interface CommandTemplateObjectConfig {
  label?: string;
  mode?: CommandTemplateMode;
  template?: CommandTemplateValue;
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number;
  delay?: number;
  output?: string;
  retry?: number;
  critical?: boolean;
  repeat?: number;
}

export type CommandTemplateValue = string | CommandTemplateConfig[] | CommandTemplateObjectConfig;

export type CommandTemplateConfig = string | CommandTemplateObjectConfig;

export interface CommandTemplateLeafConfig extends CommandTemplateObjectConfig {
  template: string;
}

export interface CommandTemplateInvocation {
  command: string;
  args: string[];
}

export interface CommandTemplateExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  killGrace?: number;
  retry?: number;
}

export interface CommandTemplateExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type CommandTemplateExecCommand = (
  command: string,
  args: string[],
  options?: CommandTemplateExecOptions,
) => Promise<CommandTemplateExecResult>;

function normalizeCommandTemplateArgs(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim());
}

export function normalizeCommandTemplateConfig(
  config: CommandTemplateConfig,
): CommandTemplateObjectConfig {
  return typeof config === "string" ? { template: config } : config;
}

function normalizeCommandTemplateDefaults(
  defaults: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!defaults) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    normalized[key] =
      value === undefined || value === null ? "" : String(value);
  }
  return normalized;
}

function normalizeRepeat(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1)
    throw new Error("Command template repeat must be a positive integer.");
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function isCommandTemplateRepeatPlaceholder(name: string): boolean {
  return /^_{0,6}(?:index|prev|next|repeat)$/.test(name);
}

export function getCommandTemplateRepeatDefaults(
  index: number,
  repeat: number,
): Record<string, string> {
  const prev = (index - 1 + repeat) % repeat;
  const next = (index + 1) % repeat;
  const values: Record<string, string> = {
    index: String(index),
    next: String(next),
    prev: String(prev),
    repeat: String(repeat),
  };
  for (const name of ["index", "prev", "next", "repeat"]) {
    const numeric = Number(values[name]);
    for (let underscores = 1; underscores <= 6; underscores += 1) {
      values[`${"_".repeat(underscores)}${name}`] = pad(numeric, underscores + 1);
    }
  }
  return values;
}

function expandRepeatConfig(
  config: CommandTemplateObjectConfig,
  context: Pick<CommandTemplateObjectConfig, "args" | "defaults">,
): CommandTemplateObjectConfig[] | undefined {
  const repeat = normalizeRepeat(config.repeat);
  if (repeat === undefined) return undefined;
  return Array.from({ length: repeat }, (_unused, index0) => {
    const { repeat: _repeat, ...rest } = config;
    return {
      ...rest,
      defaults: {
        ...(context.defaults ?? {}),
        ...(rest.defaults ?? {}),
        ...getCommandTemplateRepeatDefaults(index0, repeat),
      },
    };
  });
}

export function expandCommandTemplateConfigs(
  config: CommandTemplateConfig,
  inherited: Pick<CommandTemplateObjectConfig, "args" | "defaults"> = {},
): CommandTemplateLeafConfig[] {
  const normalizedConfig = normalizeCommandTemplateConfig(config);
  const inheritedDefaults = normalizeCommandTemplateDefaults(
    inherited.defaults,
  );
  const ownDefaults = normalizeCommandTemplateDefaults(
    normalizedConfig.defaults,
  );
  const context = {
    ...(inherited.args !== undefined ? { args: inherited.args } : {}),
    ...(inheritedDefaults ? { defaults: inheritedDefaults } : {}),
    ...(normalizedConfig.args !== undefined
      ? { args: normalizedConfig.args }
      : {}),
    ...(ownDefaults
      ? { defaults: { ...(inheritedDefaults ?? {}), ...ownDefaults } }
      : {}),
  };
  const repeated = expandRepeatConfig(normalizedConfig, context);
  if (repeated) {
    return repeated.flatMap((step) => expandCommandTemplateConfigs(step, context));
  }
  if (Array.isArray(normalizedConfig.template)) {
    return normalizedConfig.template.flatMap((step) =>
      expandCommandTemplateConfigs(step, context),
    );
  }
  if (typeof normalizedConfig.template !== "string") return [];
  return [
    {
      ...normalizedConfig,
      ...context,
      template: normalizedConfig.template,
      retry: normalizedConfig.retry,
      critical: normalizedConfig.critical,
    },
  ];
}

export function getCommandTemplateDefaults(
  config: CommandTemplateConfig | undefined,
): Record<string, string> {
  const normalizedConfig = config
    ? normalizeCommandTemplateConfig(config)
    : undefined;
  const defaults: Record<string, string> = {};
  for (const item of normalizeCommandTemplateArgs(normalizedConfig?.args)) {
    if (!item) continue;
    const [name, ...defaultParts] = item.split("=");
    if (!name || defaultParts.length === 0) continue;
    defaults[name.trim()] = defaultParts.join("=").trim();
  }
  for (const [key, value] of Object.entries(normalizedConfig?.defaults ?? {})) {
    defaults[key] = value === undefined || value === null ? "" : String(value);
  }
  return defaults;
}

export function splitCommandTemplate(input: string): string[] {
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

export function expandCommandTemplateExecutable(
  command: string,
  cwd: string,
): string {
  if (command === "~") return homedir();
  if (command.startsWith("~/")) return resolve(homedir(), command.slice(2));
  if (command.includes("/") && !isAbsolute(command))
    return resolve(cwd, command);
  return command;
}

function evaluateCommandTemplateExpression(
  expression: string,
  values: Record<string, string>,
): number {
  let index = 0;
  const source = expression.replace(/\s+/g, "");
  function peek(): string | undefined {
    return source[index];
  }
  function consume(char: string): boolean {
    if (peek() !== char) return false;
    index += 1;
    return true;
  }
  function parsePrimary(): number {
    if (consume("(")) {
      const value = parseExpression();
      if (!consume(")")) throw new Error(`Invalid command template expression: ${expression}`);
      return value;
    }
    const numberMatch = source.slice(index).match(/^\d+/);
    if (numberMatch) {
      index += numberMatch[0].length;
      return Number(numberMatch[0]);
    }
    const nameMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
    if (nameMatch) {
      index += nameMatch[0].length;
      const value = values[nameMatch[0]];
      if (value === undefined || !/^-?\d+$/.test(value))
        throw new Error(`Invalid command template expression variable: ${nameMatch[0]}`);
      return Number(value);
    }
    throw new Error(`Invalid command template expression: ${expression}`);
  }
  function parseTerm(): number {
    let value = parsePrimary();
    while (true) {
      if (consume("*")) value *= parsePrimary();
      else if (consume("/")) value = Math.trunc(value / parsePrimary());
      else if (consume("%")) value %= parsePrimary();
      else return value;
    }
  }
  function parseExpression(): number {
    let value = parseTerm();
    while (true) {
      if (consume("+")) value += parseTerm();
      else if (consume("-")) value -= parseTerm();
      else return value;
    }
  }
  const value = parseExpression();
  if (index !== source.length) throw new Error(`Invalid command template expression: ${expression}`);
  return value;
}

function substituteCommandTemplateExpression(
  content: string,
  values: Record<string, string>,
): string | undefined {
  const padded = content.match(/^(_{1,6})\((.+)\)$/);
  if (padded) {
    return pad(evaluateCommandTemplateExpression(padded[2], values), padded[1].length + 1);
  }
  if (!/[()+\-*\/%]/.test(content)) return undefined;
  return String(evaluateCommandTemplateExpression(content, values));
}

export function substituteCommandTemplateToken(
  token: string,
  values: Record<string, string>,
  missingLabel = "command template",
): string {
  return token.replace(
    /\{([^{}]+)\}/g,
    (_match, content: string) => {
      const simple = content.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:=([^}]*))?$/);
      if (simple) {
        const [, name, inlineDefault] = simple;
        if (Object.hasOwn(values, name)) return values[name] ?? "";
        if (inlineDefault !== undefined) return inlineDefault;
      }
      const expression = substituteCommandTemplateExpression(content, values);
      if (expression !== undefined) return expression;
      throw new Error(`Missing ${missingLabel} value: ${content}`);
    },
  );
}

export async function execCommandTemplate(
  command: string,
  args: string[],
  options: CommandTemplateExecOptions = {},
): Promise<CommandTemplateExecResult> {
  const maxAttempts = options.retry ?? 1;
  let lastResult: CommandTemplateExecResult = {
    stdout: "",
    stderr: "",
    code: 1,
    killed: false,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await execCommandTemplateOnce(command, args, options);
    if (result.code === 0) return result;
    lastResult = result;
  }
  return lastResult;
}

function execCommandTemplateOnce(
  command: string,
  args: string[],
  options: CommandTemplateExecOptions = {},
): Promise<CommandTemplateExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let killTimeoutId: NodeJS.Timeout | undefined;
    const killProcess = (): void => {
      if (killed) return;
      killed = true;
      proc.kill("SIGTERM");
      killTimeoutId = setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, options.killGrace ?? 5000);
    };
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      if (options.signal)
        options.signal.removeEventListener("abort", killProcess);
      resolve({ stdout, stderr, code, killed });
    };
    if (options.signal) {
      if (options.signal.aborted) killProcess();
      else
        options.signal.addEventListener("abort", killProcess, { once: true });
    }
    if (options.timeout !== undefined && options.timeout > 0)
      timeoutId = setTimeout(killProcess, options.timeout);
    else if (options.timeout === undefined)
      timeoutId = setTimeout(killProcess, DEFAULT_COMMAND_TIMEOUT_MS);
    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    proc.stdin?.on("error", () => {});
    if (options.stdin !== undefined) proc.stdin?.end(options.stdin);
    proc.on("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      settle(1);
    });
    proc.on("close", (code) => {
      settle(code ?? (killed ? 1 : 0));
    });
  });
}

export function buildCommandTemplateInvocation(
  config: CommandTemplateConfig,
  values: Record<string, string>,
  cwd: string,
  options: { emptyMessage?: string; missingLabel?: string } = {},
): CommandTemplateInvocation {
  const normalizedConfig = normalizeCommandTemplateConfig(config);
  if (Array.isArray(normalizedConfig.template)) {
    throw new Error(
      options.emptyMessage ??
        "Command template sequence cannot be executed as one command",
    );
  }
  if (!normalizedConfig.template)
    throw new Error(options.emptyMessage ?? "Command template is required");
  if (typeof normalizedConfig.template !== "string") {
    throw new Error(
      options.emptyMessage ??
        "Command template object cannot be executed as one command",
    );
  }
  const parts = splitCommandTemplate(normalizedConfig.template);
  const commandPart = parts[0];
  if (!commandPart)
    throw new Error(options.emptyMessage ?? "Command template is empty");
  const resolvedValues = {
    ...getCommandTemplateDefaults(normalizedConfig),
    ...values,
  };
  const command = expandCommandTemplateExecutable(
    substituteCommandTemplateToken(
      commandPart,
      resolvedValues,
      options.missingLabel,
    ),
    cwd,
  );
  const args = parts
    .slice(1)
    .map((part) =>
      substituteCommandTemplateToken(
        part,
        resolvedValues,
        options.missingLabel,
      ),
    );
  return { command, args };
}
