/**
 * Registered tool execution runtime
 * Owns command-template invocation execution and pi tool-result payload formatting
 */

import type { RegisteredTool } from "./config.ts";
import { formatFailureOutput, formatOutput, formatToolText } from "./output.ts";
import * as CommandTemplates from "./command-templates.ts";

export interface ToolExecOptions {
  cwd?: string;
  signal?: AbortSignal;
  stdin?: string;
  timeout?: number;
}

export interface ToolExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface RegisteredToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    code: number;
    command: string;
    fullOutputPath?: string;
    killed: boolean;
    template: CommandTemplates.CommandTemplateValue;
    tool: string;
    truncated: boolean;
  };
}

export type RegisteredToolExec = (
  command: string,
  args: string[],
  options?: ToolExecOptions,
) => Promise<ToolExecResult>;

const TOOL_TIMEOUT_MS = 120_000;

function textContent(text: string) {
  return { type: "text" as const, text };
}

function createTemplateConfig(cfg: RegisteredTool): CommandTemplates.CommandTemplateObjectConfig {
  return { args: cfg.args, defaults: cfg.defaults, template: cfg.template };
}

function formatCommandDetail(commands: string[]): string {
  return commands.length === 1 ? commands[0] : commands.join(" && ");
}

async function executeTemplateSteps(
  cfg: RegisteredTool,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ commands: string[]; result: ToolExecResult }> {
  const steps = CommandTemplates.expandCommandTemplateConfigs(createTemplateConfig(cfg));
  if (steps.length === 0)
    throw new Error(formatToolText("Tool template produced no command steps."));
  const commands: string[] = [];
  let stdin: string | undefined;
  let result: ToolExecResult | undefined;
  for (const step of steps) {
    const invocation = CommandTemplates.buildCommandTemplateInvocation(
      step,
      params,
      cwd,
      { emptyMessage: "Tool template produced an empty command." },
    );
    commands.push(invocation.command);
    result = await exec(invocation.command, invocation.args, {
      cwd,
      signal,
      stdin,
      timeout: step.timeout ?? TOOL_TIMEOUT_MS,
    });
    if (result.code !== 0) return { commands, result };
    stdin = result.stdout;
  }
  return { commands, result: result! };
}

export async function executeRegisteredTool(
  cfg: RegisteredTool,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<RegisteredToolExecutionResult> {
  const executed = await executeTemplateSteps(cfg, params, exec, cwd, signal);
  const command = formatCommandDetail(executed.commands);
  const result = executed.result;
  if (result.code !== 0) {
    const formatted = formatFailureOutput(
      cfg.name,
      result.code,
      result.killed,
      result.stdout,
      result.stderr,
    );
    throw new Error(formatted.text);
  }
  const formatted = formatOutput(cfg.name, "stdout", result.stdout);
  return {
    content: [textContent(formatted.text)],
    details: {
      code: result.code,
      command,
      fullOutputPath: formatted.fullOutputPath,
      killed: result.killed,
      template: cfg.template,
      tool: cfg.name,
      truncated: formatted.truncated,
    },
  };
}
