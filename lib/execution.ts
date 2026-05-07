/**
 * Registered tool execution runtime
 * Zones: tool execution, command templates, output formatting
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

export interface BranchReport {
  code: number;
  command: string;
  killed: boolean;
  label: string;
  status: "done" | "failed" | "timeout";
  stderr?: string;
  stdoutBytes: number;
}

export interface SoftQuorumReport {
  coverage: number;
  degraded: boolean;
  done: number;
  expected: number;
  failed: number;
  usable: boolean;
}

export interface RegisteredToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    branches?: BranchReport[];
    code: number;
    command: string;
    fullOutputPath?: string;
    killed: boolean;
    nonCriticalFailures?: Array<{ code: number; command: string; killed: boolean }>;
    softQuorum?: SoftQuorumReport;
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

type TemplateExecution = {
  branches: BranchReport[];
  commands: string[];
  criticalFailure?: boolean;
  failures: Array<{ code: number; command: string; killed: boolean }>;
  result: ToolExecResult;
};

const TOOL_TIMEOUT_MS = CommandTemplates.DEFAULT_COMMAND_TIMEOUT_MS;

function textContent(text: string) {
  return { type: "text" as const, text };
}

function createTemplateConfig(cfg: RegisteredTool): CommandTemplates.CommandTemplateObjectConfig {
  if (!cfg.template) throw new Error(`Tool "${cfg.name}" has no command template.`);
  return { args: cfg.args, defaults: cfg.defaults, template: cfg.template };
}

function formatCommandDetail(commands: string[]): string {
  return commands.length === 1 ? commands[0] : commands.join(" && ");
}

function mergeDefaults(
  inherited: Record<string, unknown> | undefined,
  own: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!inherited && !own) return undefined;
  return { ...(inherited ?? {}), ...(own ?? {}) };
}

function getNodeLabel(
  config: CommandTemplates.CommandTemplateConfig,
  index?: number,
): string {
  const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
  if (normalized.label) return normalized.label;
  return index === undefined ? "command" : `branch ${index + 1}`;
}

function getBranchStatus(result: ToolExecResult): BranchReport["status"] {
  if (result.code === 0) return "done";
  return result.killed ? "timeout" : "failed";
}

function createBranchReport(
  label: string,
  command: string,
  result: ToolExecResult,
): BranchReport {
  return {
    code: result.code,
    command,
    killed: result.killed,
    label,
    status: getBranchStatus(result),
    ...(result.stderr ? { stderr: result.stderr.slice(0, 1000) } : {}),
    stdoutBytes: Buffer.byteLength(result.stdout),
  };
}

function createSoftQuorum(branches: BranchReport[]): SoftQuorumReport | undefined {
  if (branches.length === 0) return undefined;
  const done = branches.filter((branch) => branch.status === "done").length;
  const failed = branches.length - done;
  return {
    coverage: done / branches.length,
    degraded: failed > 0,
    done,
    expected: branches.length,
    failed,
    usable: done > 0,
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    let timeoutId: NodeJS.Timeout | undefined;
    const settle = (): void => {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", settle);
      resolve();
    };
    if (signal?.aborted) return settle();
    timeoutId = setTimeout(settle, ms);
    if (signal) signal.addEventListener("abort", settle, { once: true });
  });
}

async function applyDelay(
  delay: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delay === undefined || delay <= 0) return;
  await sleep(delay, signal);
}

function joinParallelStdout(branches: BranchReport[], results: ToolExecResult[]): string {
  return results
    .map((result, index) => {
      const branch = branches[index];
      const header = `--- branch: ${branch.label} status: ${branch.status} ---`;
      if (branch.status === "done") return `${header}\n${result.stdout}`;
      const stderr = branch.stderr ? `\nstderr: ${branch.stderr}` : "";
      return `${header}\nexit: ${branch.code}${stderr}`;
    })
    .join("\n");
}

async function executeTemplateConfig(
  config: CommandTemplates.CommandTemplateConfig,
  inherited: Pick<CommandTemplates.CommandTemplateObjectConfig, "args" | "defaults">,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal: AbortSignal | undefined,
  stdin: string | undefined,
  isRoot: boolean,
): Promise<TemplateExecution> {
  const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
  await applyDelay(normalized.delay, signal);
  const context = {
    ...(inherited.args !== undefined ? { args: inherited.args } : {}),
    ...(inherited.defaults !== undefined ? { defaults: inherited.defaults } : {}),
    ...(normalized.args !== undefined ? { args: normalized.args } : {}),
    ...(mergeDefaults(inherited.defaults, normalized.defaults)
      ? { defaults: mergeDefaults(inherited.defaults, normalized.defaults) }
      : {}),
  };
  if (!Array.isArray(normalized.template)) {
    const leaf = { ...normalized, ...context };
    const invocation = CommandTemplates.buildCommandTemplateInvocation(
      leaf,
      params as Record<string, string>,
      cwd,
      { emptyMessage: "Tool template produced an empty command." },
    );
    const result = await exec(invocation.command, invocation.args, {
      cwd,
      signal,
      stdin,
      timeout: normalized.timeout ?? TOOL_TIMEOUT_MS,
      ...(normalized.retry !== undefined ? { retry: normalized.retry } : {}),
    });
    return { branches: [], commands: [invocation.command], failures: [], result };
  }
  if (normalized.template.length === 0)
    throw new Error(formatToolText("Tool template produced no command steps."));
  if ((normalized.mode ?? "sequence") === "parallel") {
    const branchResults = await Promise.all(
      normalized.template.map((step) =>
        executeTemplateConfig(step, context, params, exec, cwd, signal, stdin, false),
      ),
    );
    const commands = branchResults.flatMap((item) => item.commands);
    const failures = branchResults.flatMap((item) => item.failures);
    const branches = branchResults.map((item, index) =>
      createBranchReport(
        getNodeLabel(normalized.template![index], index),
        item.commands.at(-1) ?? "<template>",
        item.result,
      ),
    );
    const criticalFailure = branchResults.find(
      (item, index) =>
        item.result.code !== 0 &&
        (item.criticalFailure ||
          CommandTemplates.normalizeCommandTemplateConfig(
            normalized.template![index],
          ).critical ||
          normalized.critical),
    );
    if (criticalFailure) {
      return {
        branches: [...branchResults.flatMap((item) => item.branches), ...branches],
        commands,
        criticalFailure: true,
        failures,
        result: criticalFailure.result,
      };
    }
    const successful = branchResults.map((item) => {
      if (item.result.code === 0) return item.result;
      failures.push({
        code: item.result.code,
        command: item.commands.at(-1) ?? "<template>",
        killed: item.result.killed,
      });
      return { ...item.result, code: 0, stdout: "" };
    });
    return {
      commands,
      branches: [...branchResults.flatMap((item) => item.branches), ...branches],
      failures,
      result: {
        code: 0,
        killed: successful.some((item) => item.killed),
        stderr: successful.map((item) => item.stderr).filter(Boolean).join("\n"),
        stdout: joinParallelStdout(branches, successful),
      },
    };
  }
  const branches: BranchReport[] = [];
  const commands: string[] = [];
  const failures: Array<{ code: number; command: string; killed: boolean }> = [];
  let nextStdin = stdin;
  let result: ToolExecResult | undefined;
  for (const step of normalized.template) {
    const executed = await executeTemplateConfig(
      step,
      context,
      params,
      exec,
      cwd,
      signal,
      nextStdin,
      false,
    );
    branches.push(...executed.branches);
    commands.push(...executed.commands);
    failures.push(...executed.failures);
    result = executed.result;
    const stepConfig = CommandTemplates.normalizeCommandTemplateConfig(step);
    if (result.code !== 0) {
      if (
        executed.criticalFailure ||
        stepConfig.critical ||
        normalized.critical ||
        (isRoot && normalized.template.length === 1)
      ) {
        return {
          branches,
          commands,
          criticalFailure: executed.criticalFailure || stepConfig.critical || normalized.critical,
          failures,
          result,
        };
      }
      failures.push({
        code: result.code,
        command: executed.commands.at(-1) ?? "<template>",
        killed: result.killed,
      });
      result = { ...result, code: 0, stdout: "" };
      nextStdin = "";
      continue;
    }
    nextStdin = result.stdout;
  }
  return { branches, commands, failures, result: result! };
}

async function executeTemplateSteps(
  cfg: RegisteredTool,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<TemplateExecution> {
  return executeTemplateConfig(
    createTemplateConfig(cfg),
    {},
    params,
    exec,
    cwd,
    signal,
    undefined,
    true,
  );
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
      ...(executed.branches.length > 0 ? { branches: executed.branches } : {}),
      ...(executed.failures.length > 0
        ? { nonCriticalFailures: executed.failures }
        : {}),
      ...(createSoftQuorum(executed.branches)
        ? { softQuorum: createSoftQuorum(executed.branches) }
        : {}),
      template: cfg.template!,
      tool: cfg.name,
      truncated: formatted.truncated,
    },
  };
}
