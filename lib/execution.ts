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
  retry?: number;
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
    nonCriticalFailures?: Array<{ code: number; command: string; killed: boolean }>;
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

const TOOL_TIMEOUT_MS = CommandTemplates.DEFAULT_COMMAND_TIMEOUT_MS;

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
): Promise<{
  commands: string[];
  failures: Array<{ code: number; command: string; killed: boolean }>;
  result: ToolExecResult;
}> {
  const steps = CommandTemplates.expandCommandTemplateConfigs(createTemplateConfig(cfg));
  if (steps.length === 0)
    throw new Error(formatToolText("Tool template produced no command steps."));
  const commands: string[] = [];
  const failures: Array<{ code: number; command: string; killed: boolean }> = [];
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
      ...(step.retry !== undefined ? { retry: step.retry } : {}),
    });
    if (result.code !== 0) {
      if (step.critical || steps.length === 1) return { commands, failures, result };
      failures.push({
        code: result.code,
        command: invocation.command,
        killed: result.killed,
      });
      result = { ...result, code: 0, stdout: "" };
      stdin = "";
      continue;
    }
    stdin = result.stdout;
  }
  return { commands, failures, result: result! };
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
      ...(executed.failures.length > 0
        ? { nonCriticalFailures: executed.failures }
        : {}),
      template: cfg.template,
      tool: cfg.name,
      truncated: formatted.truncated,
    },
  };
}
