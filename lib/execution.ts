/**
 * Registered tool execution runtime
 * Owns command-template invocation execution and pi tool-result payload formatting
 */

import type { RegisteredTool } from "./config.ts";
import {
  formatFailureOutput,
  formatOutput,
  formatToolText,
} from "./output.ts";
import {
  buildTemplateInvocation,
  resolveTemplateCommand,
} from "./templates.ts";

export interface ToolExecOptions {
  cwd?: string;
  signal?: AbortSignal;
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
    template: string;
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

export async function executeRegisteredTool(
  cfg: RegisteredTool,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<RegisteredToolExecutionResult> {
  const invocation = buildTemplateInvocation(
    cfg.template,
    params,
    cfg.args,
    cfg.defaults,
  );
  const command = invocation.command;
  if (!command) throw new Error(formatToolText("Tool template produced an empty command."));
  const result = await exec(resolveTemplateCommand(command), invocation.args, {
    cwd,
    signal,
    timeout: TOOL_TIMEOUT_MS,
  });
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
