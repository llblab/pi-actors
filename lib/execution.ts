/**
 * Registered tool execution runtime
 * Zones: tool execution, command templates, output formatting
 * Owns command-template invocation execution and pi tool-result payload formatting
 */

import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import { formatFailureOutput, formatOutput, formatToolText } from "./output.ts";
import * as Schema from "./schema.ts";

export interface ToolExecOptions {
  actorRecipeContext?: CommandTemplates.CommandTemplateActorRecipeContext;
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
    nonCriticalFailures?: Array<{
      code: number;
      command: string;
      killed: boolean;
    }>;
    softQuorum?: SoftQuorumReport;
    template: CommandTemplates.CommandTemplateValue;
    templateWarnings?: string[];
    tool: string;
    truncated: boolean;
  };
}

export type RegisteredToolExec = (
  command: string,
  args: string[],
  options?: ToolExecOptions,
) => Promise<ToolExecResult>;

const DEFAULT_MAX_PARALLEL_BRANCHES = 64;

type TemplateExecution = {
  branches: BranchReport[];
  commands: string[];
  criticalFailure?: boolean;
  failureScope?: CommandTemplates.CommandTemplateFailureScope;
  failures: Array<{ code: number; command: string; killed: boolean }>;
  result: ToolExecResult;
};

function textContent(text: string) {
  return { type: "text" as const, text };
}

function createTemplateConfig(
  cfg: RegisteredTool,
): CommandTemplates.CommandTemplateObjectConfig {
  if (!cfg.template)
    throw new Error(`Tool "${cfg.name}" has no command template.`);
  if (typeof cfg.template === "object" && !Array.isArray(cfg.template)) {
    return {
      ...cfg.template,
      args: cfg.template.args ?? cfg.args,
      defaults: mergeDefaults(cfg.defaults, cfg.template.defaults),
    };
  }
  return { args: cfg.args, defaults: cfg.defaults, template: cfg.template };
}

function quoteCommandDetailPart(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_/:=.,@%+\-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatInvocationDetail(
  invocation: CommandTemplates.CommandTemplateInvocation,
): string {
  return [invocation.command, ...invocation.args]
    .map(quoteCommandDetailPart)
    .join(" ");
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

function createSoftQuorum(
  branches: BranchReport[],
): SoftQuorumReport | undefined {
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

function getMaxParallelBranches(): number {
  const raw = Number(process.env.PI_ACTORS_MAX_PARALLEL_BRANCHES ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_PARALLEL_BRANCHES;
}

function assertParallelBranchLimit(count: number): void {
  const max = getMaxParallelBranches();
  if (count <= max) return;
  throw new Error(
    `Command template parallel fanout ${count} exceeds limit ${max}; set PI_ACTORS_MAX_PARALLEL_BRANCHES to override intentionally.`,
  );
}

function normalizeFailureScope(
  value: CommandTemplates.CommandTemplateFailureScope | undefined,
): CommandTemplates.CommandTemplateFailureScope {
  if (value === undefined) return "continue";
  if (value === "continue" || value === "branch" || value === "root")
    return value;
  throw new Error(
    "Command template failure must be one of: continue, branch, root.",
  );
}

function getFailureScope(
  config: CommandTemplates.CommandTemplateConfig,
): CommandTemplates.CommandTemplateFailureScope {
  const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
  return normalizeFailureScope(normalized.failure);
}

function maxFailureScope(
  ...scopes: Array<CommandTemplates.CommandTemplateFailureScope | undefined>
): CommandTemplates.CommandTemplateFailureScope {
  const rank = { branch: 1, continue: 0, root: 2 } as const;
  return scopes.reduce<CommandTemplates.CommandTemplateFailureScope>(
    (current, scope) =>
      rank[scope ?? "continue"] > rank[current] ? scope! : current,
    "continue",
  );
}

function normalizeRetry(
  value: number | string | undefined,
  values: Record<string, unknown>,
): number {
  const resolved = resolveNumericControlField(value, values, "retry");
  if (resolved === undefined) return 1;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new Error("Command template retry must be a positive integer.");
  return resolved;
}

function getRecoverConfig(
  config: CommandTemplates.CommandTemplateValue,
): CommandTemplates.CommandTemplateConfig {
  const recovered = Array.isArray(config) ? { template: config } : config;
  const normalized = CommandTemplates.normalizeCommandTemplateConfig(recovered);
  if (normalized.failure !== undefined) return recovered;
  return { ...normalized, failure: "root" };
}

function addResultFailure(
  failures: Array<{ code: number; command: string; killed: boolean }>,
  execution: TemplateExecution,
): void {
  if (execution.result.code === 0) return;
  const failure = {
    code: execution.result.code,
    command: execution.commands.at(-1) ?? "<template>",
    killed: execution.result.killed,
  };
  const last = failures.at(-1);
  if (
    last?.code === failure.code &&
    last.command === failure.command &&
    last.killed === failure.killed
  )
    return;
  failures.push(failure);
}

function mergeExecution(
  target: TemplateExecution,
  source: TemplateExecution,
): void {
  target.branches.push(...source.branches);
  target.commands.push(...source.commands);
  target.failures.push(...source.failures);
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

function resolveNumericControlField(
  value: number | string | undefined,
  values: Record<string, unknown>,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const resolved =
    typeof value === "string"
      ? CommandTemplates.substituteCommandTemplateToken(value, values, label)
      : value;
  if (resolved === "") return undefined;
  const numeric = Number(resolved);
  if (!Number.isFinite(numeric) || numeric < 0)
    throw new Error(`Command template ${label} must be a non-negative number.`);
  return numeric;
}

async function applyDelay(
  delay: number | string | undefined,
  values: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const resolved = resolveNumericControlField(delay, values, "delay");
  if (resolved === undefined || resolved <= 0) return;
  await sleep(resolved, signal);
}

function joinParallelStdout(
  branches: BranchReport[],
  results: ToolExecResult[],
): string {
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

async function executeRetriableTemplateConfig(
  normalized: CommandTemplates.CommandTemplateObjectConfig,
  inherited: Pick<
    CommandTemplates.CommandTemplateObjectConfig,
    "args" | "defaults"
  >,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal: AbortSignal | undefined,
  stdin: string | undefined,
  isRoot: boolean,
  actorRecipeContext: CommandTemplates.CommandTemplateActorRecipeContext | undefined,
): Promise<TemplateExecution> {
  const maxAttempts = normalizeRetry(normalized.retry, {
    ...(inherited.defaults ?? {}),
    ...params,
  });
  const attemptConfig = {
    ...normalized,
    delay: undefined,
    recover: undefined,
    retry: undefined,
  };
  const aggregate: TemplateExecution = {
    branches: [],
    commands: [],
    failures: [],
    result: { code: 1, killed: false, stderr: "", stdout: "" },
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const executed = await executeTemplateConfig(
      attemptConfig,
      inherited,
      params,
      exec,
      cwd,
      signal,
      stdin,
      isRoot,
      actorRecipeContext,
    );
    mergeExecution(aggregate, executed);
    aggregate.result = executed.result;
    aggregate.criticalFailure = executed.criticalFailure;
    aggregate.failureScope = executed.failureScope;
    if (executed.result.code === 0) return aggregate;
    addResultFailure(aggregate.failures, executed);
    if (attempt === maxAttempts) return aggregate;
    if (normalized.recover === undefined) continue;
    const recovered = await executeTemplateConfig(
      getRecoverConfig(normalized.recover),
      inherited,
      params,
      exec,
      cwd,
      signal,
      executed.result.stdout,
      false,
      actorRecipeContext,
    );
    mergeExecution(aggregate, recovered);
    if (recovered.result.code === 0) continue;
    addResultFailure(aggregate.failures, recovered);
    aggregate.result = recovered.result;
    aggregate.criticalFailure = recovered.criticalFailure;
    aggregate.failureScope = maxFailureScope(
      recovered.failureScope,
      getFailureScope(normalized),
    );
    return aggregate;
  }
  return aggregate;
}

async function executeTemplateConfig(
  config: CommandTemplates.CommandTemplateConfig,
  inherited: Pick<
    CommandTemplates.CommandTemplateObjectConfig,
    "args" | "defaults"
  >,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal: AbortSignal | undefined,
  stdin: string | undefined,
  isRoot: boolean,
  inheritedActorRecipeContext: CommandTemplates.CommandTemplateActorRecipeContext | undefined,
): Promise<TemplateExecution> {
  const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
  const normalizedDefaults = CommandTemplates.resolveInheritedDefaultReferences(
    normalized.defaults,
    inherited.defaults,
    params,
  );
  const context = {
    ...(inherited.args !== undefined ? { args: inherited.args } : {}),
    ...(inherited.defaults !== undefined
      ? { defaults: inherited.defaults }
      : {}),
    ...(normalized.args !== undefined ? { args: normalized.args } : {}),
    ...(mergeDefaults(inherited.defaults, normalizedDefaults)
      ? { defaults: mergeDefaults(inherited.defaults, normalizedDefaults) }
      : {}),
  };
  const actorRecipeContext = normalized.actorRecipeContext ?? inheritedActorRecipeContext;
  const controlValues = { ...(context.defaults ?? {}), ...params };
  await applyDelay(normalized.delay, controlValues, signal);
  if (
    !CommandTemplates.shouldRunCommandTemplateNode(
      normalized.when,
      controlValues,
    )
  ) {
    return {
      branches: [],
      commands: [],
      failures: [],
      result: { code: 0, killed: false, stderr: "", stdout: stdin ?? "" },
    };
  }
  getFailureScope(normalized);
  if (normalized.repeat !== undefined) {
    const repeat = CommandTemplates.resolveCommandTemplateRepeat(
      normalized.repeat,
      { ...(context.defaults ?? {}), ...params },
    );
    if (repeat === undefined)
      throw new Error("Command template repeat could not be resolved.");
    if (normalized.parallel === true) assertParallelBranchLimit(repeat);
    const repeatedSteps = Array.from({ length: repeat }, (_unused, index0) => {
      const { repeat: _repeat, ...rest } = normalized;
      return {
        ...rest,
        defaults: {
          ...(context.defaults ?? {}),
          ...(rest.defaults ?? {}),
          ...CommandTemplates.getCommandTemplateRepeatDefaults(index0, repeat),
        },
      };
    });
    return executeTemplateConfig(
      { parallel: normalized.parallel === true, template: repeatedSteps },
      context,
      params,
      exec,
      cwd,
      signal,
      stdin,
      isRoot,
      actorRecipeContext,
    );
  }
  if (
    normalized.retry !== undefined &&
    (Array.isArray(normalized.template) || normalized.recover !== undefined)
  ) {
    return executeRetriableTemplateConfig(
      normalized,
      context,
      params,
      exec,
      cwd,
      signal,
      stdin,
      isRoot,
      actorRecipeContext,
    );
  }
  if (
    normalized.template &&
    typeof normalized.template === "object" &&
    !Array.isArray(normalized.template)
  ) {
    return executeTemplateConfig(
      normalized.template,
      context,
      params,
      exec,
      cwd,
      signal,
      stdin,
      false,
      actorRecipeContext,
    );
  }
  if (!Array.isArray(normalized.template)) {
    const leaf = { ...normalized, ...context };
    const invocation = CommandTemplates.buildCommandTemplateInvocation(
      leaf,
      params as Record<string, string>,
      cwd,
      { emptyMessage: "Tool template produced an empty command." },
    );
    const result = await exec(invocation.command, invocation.args, {
      ...(actorRecipeContext ? { actorRecipeContext } : {}),
      cwd,
      signal,
      stdin,
      ...(resolveNumericControlField(
        normalized.timeout,
        controlValues,
        "timeout",
      ) !== undefined
        ? {
            timeout: resolveNumericControlField(
              normalized.timeout,
              controlValues,
              "timeout",
            ),
          }
        : {}),
      ...(normalized.retry !== undefined
        ? { retry: normalizeRetry(normalized.retry, controlValues) }
        : {}),
    });
    return {
      branches: [],
      commands: [formatInvocationDetail(invocation)],
      failures: [],
      result,
    };
  }
  const steps = normalized.template;
  if (steps.length === 0)
    throw new Error(formatToolText("Tool template produced no command steps."));
  if (normalized.parallel === true) {
    assertParallelBranchLimit(steps.length);
    const branchResults = await Promise.all(
      steps.map((step) =>
        executeTemplateConfig(
          step,
          context,
          params,
          exec,
          cwd,
          signal,
          stdin,
          false,
          actorRecipeContext,
        ),
      ),
    );
    const commands = branchResults.flatMap((item) => item.commands);
    const failures = branchResults.flatMap((item) => item.failures);
    const branches = branchResults.map((item, index) =>
      createBranchReport(
        getNodeLabel(steps[index], index),
        item.commands.at(-1) ?? "<template>",
        item.result,
      ),
    );
    const nodeFailure = getFailureScope(normalized);
    const rootFailure = branchResults.find((item, index) => {
      if (item.result.code === 0) return false;
      const branchFailure = maxFailureScope(
        item.failureScope,
        item.criticalFailure ? "root" : undefined,
        getFailureScope(steps[index]),
        nodeFailure,
      );
      return branchFailure === "root";
    });
    if (rootFailure) {
      return {
        branches: [
          ...branchResults.flatMap((item) => item.branches),
          ...branches,
        ],
        commands,
        criticalFailure: true,
        failureScope: "root",
        failures,
        result: rootFailure.result,
      };
    }
    const firstFailedBranch = branchResults.find(
      (item) => item.result.code !== 0,
    );
    const successful = branchResults.map((item) => {
      if (item.result.code === 0) return item.result;
      addResultFailure(failures, item);
      return { ...item.result, code: 0, stdout: "" };
    });
    const result = {
      code: 0,
      killed: successful.some((item) => item.killed),
      stderr: successful
        .map((item) => item.stderr)
        .filter(Boolean)
        .join("\n"),
      stdout: joinParallelStdout(branches, successful),
    };
    if (firstFailedBranch && nodeFailure === "branch") {
      return {
        commands,
        branches: [
          ...branchResults.flatMap((item) => item.branches),
          ...branches,
        ],
        failureScope: "branch",
        failures,
        result: { ...result, code: firstFailedBranch.result.code || 1 },
      };
    }
    return {
      commands,
      branches: [
        ...branchResults.flatMap((item) => item.branches),
        ...branches,
      ],
      failures,
      result,
    };
  }
  const branches: BranchReport[] = [];
  const commands: string[] = [];
  const failures: Array<{ code: number; command: string; killed: boolean }> =
    [];
  let nextStdin = stdin;
  let result: ToolExecResult | undefined;
  for (const step of steps) {
    const executed = await executeTemplateConfig(
      step,
      context,
      params,
      exec,
      cwd,
      signal,
      nextStdin,
      false,
      actorRecipeContext,
    );
    branches.push(...executed.branches);
    commands.push(...executed.commands);
    failures.push(...executed.failures);
    result = executed.result;
    if (result.code !== 0) {
      const failureScope = maxFailureScope(
        executed.failureScope,
        executed.criticalFailure ? "root" : undefined,
        getFailureScope(step),
        getFailureScope(normalized),
        isRoot && steps.length === 1 ? "root" : undefined,
      );
      if (failureScope === "root") {
        return {
          branches,
          commands,
          criticalFailure: true,
          failureScope: "root",
          failures,
          result,
        };
      }
      if (failureScope === "branch") {
        addResultFailure(failures, executed);
        return {
          branches,
          commands,
          failureScope: "branch",
          failures,
          result,
        };
      }
      addResultFailure(failures, executed);
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
    undefined,
  );
}

export async function executeRegisteredTool(
  cfg: RegisteredTool,
  params: Record<string, unknown>,
  exec: RegisteredToolExec,
  cwd: string,
  signal?: AbortSignal,
): Promise<RegisteredToolExecutionResult> {
  const executed = await executeTemplateSteps(
    cfg,
    Schema.normalizeRuntimeValues(params, cfg.argTypes),
    exec,
    cwd,
    signal,
  );
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
  const templateWarnings = CommandTemplates.getCommandTemplateWarnings(
    createTemplateConfig(cfg),
  );
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
      ...(templateWarnings.length > 0 ? { templateWarnings } : {}),
      tool: cfg.name,
      truncated: formatted.truncated,
    },
  };
}
