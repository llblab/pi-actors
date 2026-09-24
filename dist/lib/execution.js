/**
 * Registered tool execution runtime
 * Zones: tool execution, command templates, output formatting
 * Owns command-template invocation execution and pi tool-result payload formatting
 */
import { readFile } from "node:fs/promises";
import * as CommandTemplates from "./command-templates.js";
import { formatFailureOutput, formatOutput, formatToolText, } from "./execution-output.js";
import * as Schema from "./schema.js";
const DEFAULT_MAX_PARALLEL_BRANCHES = 64;
function textContent(text) {
    return { type: "text", text };
}
function createTemplateConfig(cfg) {
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
function quoteCommandDetailPart(value) {
    if (value === "")
        return "''";
    if (/^[A-Za-z0-9_/:=.,@%+\-]+$/.test(value))
        return value;
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function formatInvocationDetail(invocation) {
    return [invocation.command, ...invocation.args]
        .map(quoteCommandDetailPart)
        .join(" ");
}
function formatCommandDetail(commands) {
    return commands.length === 1 ? commands[0] : commands.join(" && ");
}
function getExecutionFailureReason(branches, softQuorum, stderr) {
    if (/parallel branch quorum not met/.test(stderr)) {
        return "parallel_quorum_not_met";
    }
    if (branches.length > 0 && softQuorum?.usable === false) {
        return "all_branches_unusable";
    }
    return "command_failed";
}
function mergeDefaults(inherited, own) {
    if (!inherited && !own)
        return undefined;
    return { ...(inherited ?? {}), ...(own ?? {}) };
}
function getNodeLabel(config, index) {
    const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
    if (normalized.label)
        return normalized.label;
    return index === undefined ? "command" : `branch ${index + 1}`;
}
function getBranchStatus(result) {
    if (result.code === 0)
        return "done";
    return result.killed ? "timeout" : "failed";
}
const REVIEW_RESULT_MARKER = "ACTOR_REVIEW_RESULT";
export async function applyOutputAcceptancePolicy(result, output) {
    if (result.code !== 0 || output !== "review_evidence")
        return result;
    let semanticStdout = result.pipelineStdout ?? result.stdout;
    if (result.pipelineStdout === undefined && result.stdoutTruncated) {
        if (!result.stdoutFile)
            semanticStdout = "";
        else {
            try {
                semanticStdout = await readFile(result.stdoutFile, "utf8");
            }
            catch {
                semanticStdout = "";
            }
        }
    }
    const firstNonWhitespaceLine = semanticStdout
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0);
    if (firstNonWhitespaceLine?.trim() === REVIEW_RESULT_MARKER)
        return result;
    return {
        ...result,
        code: 65,
        stderr: [
            result.stderr,
            `review evidence rejected: missing ${REVIEW_RESULT_MARKER} marker`,
        ].filter(Boolean).join("\n"),
    };
}
async function resolvePipelineStdout(result) {
    let stdout = result.pipelineStdout ?? result.stdout;
    if (result.pipelineStdout === undefined && result.stdoutTruncated) {
        if (!result.stdoutFile)
            return undefined;
        try {
            stdout = await readFile(result.stdoutFile, "utf8");
        }
        catch {
            return undefined;
        }
    }
    return result.evidenceRef
        ? `${stdout}\nACTOR_EVIDENCE_REF: ${result.evidenceRef}`
        : stdout;
}
function rejectIncompletePipelineOutput(result) {
    return {
        ...result,
        code: 74,
        stderr: [
            result.stderr,
            `incomplete pipeline stdin: complete stdout unavailable${result.stdoutFile ? `; capture path unreadable: ${result.stdoutFile}` : ""}`,
        ].filter(Boolean).join("\n"),
    };
}
function getBranchFailureReason(result) {
    if (result.code === 0) {
        return result.stdout.trim() ? undefined : "empty_output";
    }
    if (result.killed)
        return "timeout_or_killed";
    return result.stderr.trim() ? "nonzero_exit" : "nonzero_exit_empty_stderr";
}
function createBranchReport(label, command, result) {
    const failureReason = getBranchFailureReason(result);
    return {
        code: result.code,
        command,
        ...(failureReason ? { failureReason } : {}),
        killed: result.killed,
        label,
        status: getBranchStatus(result),
        ...(result.stderr ? { stderr: result.stderr.slice(-1000) } : {}),
        stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
        stderrCapturedBytes: Buffer.byteLength(result.stderr),
        ...(result.stderrFile ? { stderrFile: result.stderrFile } : {}),
        ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
        ...(result.stdout ? { stdout: result.stdout.slice(-1000) } : {}),
        stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
        stdoutCapturedBytes: Buffer.byteLength(result.stdout),
        ...(result.stdoutFile ? { stdoutFile: result.stdoutFile } : {}),
        ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    };
}
function isUsableBranch(branch) {
    return (branch.status === "done" &&
        branch.stdoutBytes > 0 &&
        branch.stdoutTruncated !== true);
}
function createSoftQuorum(branches) {
    if (branches.length === 0)
        return undefined;
    const done = branches.filter((branch) => branch.status === "done").length;
    const failed = branches.length - done;
    return {
        coverage: done / branches.length,
        degraded: failed > 0,
        done,
        expected: branches.length,
        failed,
        usable: branches.some(isUsableBranch),
    };
}
function countUsableBranches(branches) {
    return branches.filter(isUsableBranch).length;
}
function getMaxParallelBranches() {
    const raw = Number(process.env.PI_ACTORS_MAX_PARALLEL_BRANCHES ?? "");
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_PARALLEL_BRANCHES;
}
function assertParallelBranchLimit(count) {
    const max = getMaxParallelBranches();
    if (count <= max)
        return;
    throw new Error(`Command template parallel fanout ${count} exceeds limit ${max}; set PI_ACTORS_MAX_PARALLEL_BRANCHES to override intentionally.`);
}
function normalizeFailureScope(value) {
    if (value === undefined)
        return "continue";
    if (value === "continue" || value === "branch" || value === "root")
        return value;
    throw new Error("Command template failure must be one of: continue, branch, root.");
}
function getFailureScope(config) {
    const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
    return normalizeFailureScope(normalized.failure);
}
function maxFailureScope(...scopes) {
    const rank = { branch: 1, continue: 0, root: 2 };
    return scopes.reduce((current, scope) => rank[scope ?? "continue"] > rank[current] ? scope : current, "continue");
}
function normalizeRetry(value, values) {
    const resolved = resolveNumericControlField(value, values, "retry");
    if (resolved === undefined)
        return 1;
    if (!Number.isInteger(resolved) || resolved < 1)
        throw new Error("Command template retry must be a positive integer.");
    return resolved;
}
function normalizeConcurrency(value, values, branchCount) {
    const resolved = resolveNumericControlField(value, values, "concurrency");
    if (resolved === undefined)
        return branchCount;
    if (!Number.isInteger(resolved) || resolved < 1)
        throw new Error("Command template concurrency must be a positive integer.");
    return Math.min(resolved, branchCount);
}
function normalizeMinSuccessful(value, values, branchCount) {
    const resolved = resolveNumericControlField(value, values, "min_successful");
    if (resolved === undefined)
        return undefined;
    if (!Number.isInteger(resolved) || resolved < 0)
        throw new Error("Command template min_successful must be a non-negative integer.");
    if (resolved > branchCount)
        throw new Error(`Command template min_successful ${resolved} exceeds branch count ${branchCount}.`);
    return resolved;
}
function getRecoverConfig(config) {
    const recovered = Array.isArray(config) ? { template: config } : config;
    const normalized = CommandTemplates.normalizeCommandTemplateConfig(recovered);
    if (normalized.failure !== undefined)
        return recovered;
    return { ...normalized, failure: "root" };
}
function addResultFailure(failures, execution) {
    if (execution.result.code === 0)
        return;
    const failure = {
        code: execution.result.code,
        command: execution.commands.at(-1) ?? "<template>",
        killed: execution.result.killed,
    };
    const last = failures.at(-1);
    if (last?.code === failure.code &&
        last.command === failure.command &&
        last.killed === failure.killed)
        return;
    failures.push(failure);
}
function mergeExecution(target, source) {
    target.branches.push(...source.branches);
    target.commands.push(...source.commands);
    target.failures.push(...source.failures);
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        let timeoutId;
        const settle = () => {
            if (timeoutId)
                clearTimeout(timeoutId);
            if (signal)
                signal.removeEventListener("abort", settle);
            resolve();
        };
        if (signal?.aborted)
            return settle();
        timeoutId = setTimeout(settle, ms);
        if (signal)
            signal.addEventListener("abort", settle, { once: true });
    });
}
function resolveNumericControlField(value, values, label) {
    if (value === undefined)
        return undefined;
    const resolved = typeof value === "string"
        ? CommandTemplates.substituteCommandTemplateToken(value, values, label)
        : value;
    if (resolved === "")
        return undefined;
    const numeric = Number(resolved);
    if (!Number.isFinite(numeric) || numeric < 0)
        throw new Error(`Command template ${label} must be a non-negative number.`);
    return numeric;
}
async function applyDelay(delay, values, signal) {
    const resolved = resolveNumericControlField(delay, values, "delay");
    if (resolved === undefined || resolved <= 0)
        return;
    await sleep(resolved, signal);
}
function getParallelStatus(branches, minSuccessful) {
    const usable = countUsableBranches(branches);
    if (minSuccessful !== undefined && usable < minSuccessful) {
        return "insufficient_data";
    }
    return branches.every(isUsableBranch) ? "complete" : "degraded";
}
function formatParallelStatusHeader(branches, minSuccessful) {
    if (minSuccessful === undefined)
        return undefined;
    return `--- parallel_status: ${getParallelStatus(branches, minSuccessful)} usable: ${countUsableBranches(branches)} expected: ${branches.length} minimum: ${minSuccessful} ---`;
}
function stdoutWithEvidenceReference(result) {
    return result.evidenceRef
        ? `${result.stdout}\nACTOR_EVIDENCE_REF: ${result.evidenceRef}`
        : result.stdout;
}
function joinParallelStdout(branches, results, minSuccessful) {
    const body = results
        .map((result, index) => {
        const branch = branches[index];
        const evidence = result.evidenceRef
            ? ` evidence_ref: ${result.evidenceRef}`
            : "";
        const header = `--- branch: ${branch.label} status: ${branch.status}${evidence} ---`;
        if (branch.status === "done")
            return `${header}\n${stdoutWithEvidenceReference(result)}`;
        const stdout = result.stdout ? `\nrejected_stdout: ${result.stdout}` : "";
        const stderr = branch.stderr ? `\nstderr: ${branch.stderr}` : "";
        return `${header}\nexit: ${branch.code}${stdout}${stderr}`;
    })
        .join("\n");
    return [formatParallelStatusHeader(branches, minSuccessful), body]
        .filter(Boolean)
        .join("\n");
}
async function mapConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
}
async function executeRetriableTemplateConfig(normalized, inherited, params, exec, cwd, signal, stdin, isRoot, actorRecipeContext) {
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
    const aggregate = {
        branches: [],
        commands: [],
        failures: [],
        result: { code: 1, killed: false, stderr: "", stdout: "" },
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const executed = await executeTemplateConfig(attemptConfig, inherited, params, exec, cwd, signal, stdin, isRoot, actorRecipeContext);
        mergeExecution(aggregate, executed);
        aggregate.result = executed.result;
        aggregate.criticalFailure = executed.criticalFailure;
        aggregate.failureScope = executed.failureScope;
        if (executed.result.code === 0)
            return aggregate;
        addResultFailure(aggregate.failures, executed);
        if (attempt === maxAttempts)
            return aggregate;
        if (normalized.recover === undefined)
            continue;
        const recovered = await executeTemplateConfig(getRecoverConfig(normalized.recover), inherited, params, exec, cwd, signal, executed.result.stdout, false, actorRecipeContext);
        mergeExecution(aggregate, recovered);
        if (recovered.result.code === 0)
            continue;
        addResultFailure(aggregate.failures, recovered);
        aggregate.result = recovered.result;
        aggregate.criticalFailure = recovered.criticalFailure;
        aggregate.failureScope = maxFailureScope(recovered.failureScope, getFailureScope(normalized));
        return aggregate;
    }
    return aggregate;
}
async function executeTemplateConfig(config, inherited, params, exec, cwd, signal, stdin, isRoot, inheritedActorRecipeContext) {
    const normalized = CommandTemplates.normalizeCommandTemplateConfig(config);
    const normalizedDefaults = CommandTemplates.resolveInheritedDefaultReferences(normalized.defaults, inherited.defaults, params);
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
    if (!CommandTemplates.shouldRunCommandTemplateNode(normalized.when, controlValues)) {
        return {
            branches: [],
            commands: [],
            failures: [],
            result: { code: 0, killed: false, stderr: "", stdout: stdin ?? "" },
        };
    }
    getFailureScope(normalized);
    if (normalized.repeat !== undefined) {
        const repeat = CommandTemplates.resolveCommandTemplateRepeat(normalized.repeat, { ...(context.defaults ?? {}), ...params });
        if (repeat === undefined)
            throw new Error("Command template repeat could not be resolved.");
        if (normalized.parallel === true)
            assertParallelBranchLimit(repeat);
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
        return executeTemplateConfig({
            parallel: normalized.parallel === true,
            ...(normalized.concurrency !== undefined
                ? { concurrency: normalized.concurrency }
                : {}),
            ...(normalized.min_successful !== undefined
                ? { min_successful: normalized.min_successful }
                : {}),
            ...(normalized.failure !== undefined ? { failure: normalized.failure } : {}),
            template: repeatedSteps,
        }, context, params, exec, cwd, signal, stdin, isRoot, actorRecipeContext);
    }
    if (normalized.retry !== undefined &&
        (Array.isArray(normalized.template) || normalized.recover !== undefined)) {
        return executeRetriableTemplateConfig(normalized, context, params, exec, cwd, signal, stdin, isRoot, actorRecipeContext);
    }
    if (normalized.template &&
        typeof normalized.template === "object" &&
        !Array.isArray(normalized.template)) {
        return executeTemplateConfig(normalized.template, context, params, exec, cwd, signal, stdin, false, actorRecipeContext);
    }
    if (!Array.isArray(normalized.template)) {
        const leaf = { ...normalized, ...context };
        const invocation = CommandTemplates.buildCommandTemplateInvocation(leaf, params, cwd, { emptyMessage: "Tool template produced an empty command." });
        const evidenceContext = {
            ...(normalized.accept_output
                ? { acceptOutput: normalized.accept_output }
                : {}),
            ...(normalized.label ? { label: normalized.label } : {}),
            ...(typeof controlValues.index === "string"
                ? { repeatIndex: controlValues.index }
                : {}),
        };
        const rawResult = await exec(invocation.command, invocation.args, {
            ...(actorRecipeContext ? { actorRecipeContext } : {}),
            ...(Object.keys(evidenceContext).length > 0 ? { evidenceContext } : {}),
            cwd,
            signal,
            stdin,
            ...(resolveNumericControlField(normalized.timeout, controlValues, "timeout") !== undefined
                ? {
                    timeout: resolveNumericControlField(normalized.timeout, controlValues, "timeout"),
                }
                : {}),
            ...(normalized.retry !== undefined
                ? { retry: normalizeRetry(normalized.retry, controlValues) }
                : {}),
        });
        const result = await applyOutputAcceptancePolicy(rawResult, normalized.accept_output);
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
        const concurrency = normalizeConcurrency(normalized.concurrency, controlValues, steps.length);
        const minSuccessful = normalizeMinSuccessful(normalized.min_successful, controlValues, steps.length);
        const branchResults = await mapConcurrent(steps, concurrency, (step) => executeTemplateConfig(step, context, params, exec, cwd, signal, stdin, false, actorRecipeContext));
        const branchPipelineStdouts = await Promise.all(branchResults.map((item) => resolvePipelineStdout(item.result)));
        for (const [index, item] of branchResults.entries()) {
            if (item.result.stdoutTruncated && branchPipelineStdouts[index] === undefined) {
                item.result = rejectIncompletePipelineOutput(item.result);
            }
        }
        const commands = branchResults.flatMap((item) => item.commands);
        const failures = branchResults.flatMap((item) => item.failures);
        const branches = branchResults.map((item, index) => createBranchReport(getNodeLabel(steps[index], index), item.commands.at(-1) ?? "<template>", item.result));
        const usableBranches = countUsableBranches(branches);
        const quorumUnmet = minSuccessful !== undefined && usableBranches < minSuccessful;
        const quorumFailureMessage = quorumUnmet
            ? `parallel branch quorum not met: usable ${usableBranches}/${branches.length}, minimum ${minSuccessful}`
            : "";
        const nodeFailure = getFailureScope(normalized);
        const rootFailure = branchResults.find((item, index) => {
            if (item.result.code === 0)
                return false;
            const branchFailure = maxFailureScope(item.failureScope, item.criticalFailure ? "root" : undefined, getFailureScope(steps[index]), nodeFailure);
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
        const firstFailedBranch = branchResults.find((item) => item.result.code !== 0);
        const allBranchesUnusable = branches.every((branch) => !isUsableBranch(branch));
        const successful = branchResults.map((item) => {
            if (item.result.code === 0)
                return item.result;
            addResultFailure(failures, item);
            return { ...item.result, code: 0 };
        });
        const completeSuccessful = successful.map((item, index) => ({
            ...item,
            stdout: branchPipelineStdouts[index] ?? item.stdout,
            evidenceRef: undefined,
        }));
        const result = {
            code: 0,
            killed: successful.some((item) => item.killed),
            stderr: successful
                .map((item) => item.stderr)
                .filter(Boolean)
                .join("\n"),
            stdout: joinParallelStdout(branches, successful, minSuccessful),
            pipelineStdout: joinParallelStdout(branches, completeSuccessful, minSuccessful),
            stdoutBytes: successful.reduce((total, item) => total + (item.stdoutBytes ?? Buffer.byteLength(item.stdout)), 0),
            ...(successful.some((item) => item.stdoutTruncated)
                ? { stdoutTruncated: true }
                : {}),
        };
        if (quorumUnmet && nodeFailure === "root") {
            return {
                commands,
                branches: [
                    ...branchResults.flatMap((item) => item.branches),
                    ...branches,
                ],
                criticalFailure: true,
                failureScope: "root",
                failures,
                result: {
                    ...result,
                    code: firstFailedBranch?.result.code || 1,
                    stderr: [result.stderr, quorumFailureMessage]
                        .filter(Boolean)
                        .join("\n"),
                },
            };
        }
        const branchFailureTriggered = minSuccessful === undefined
            ? firstFailedBranch || allBranchesUnusable
            : quorumUnmet;
        if (branchFailureTriggered && nodeFailure === "branch") {
            return {
                commands,
                branches: [
                    ...branchResults.flatMap((item) => item.branches),
                    ...branches,
                ],
                failureScope: "branch",
                failures,
                result: {
                    ...result,
                    code: firstFailedBranch?.result.code || 1,
                    stderr: [
                        result.stderr,
                        allBranchesUnusable
                            ? "all parallel branches failed or produced empty output"
                            : "",
                        quorumFailureMessage,
                    ]
                        .filter(Boolean)
                        .join("\n"),
                },
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
    const branches = [];
    const commands = [];
    const failures = [];
    let nextStdin = stdin;
    let result;
    for (const [stepIndex, step] of steps.entries()) {
        const executed = await executeTemplateConfig(step, context, params, exec, cwd, signal, nextStdin, false, actorRecipeContext);
        branches.push(...executed.branches);
        commands.push(...executed.commands);
        failures.push(...executed.failures);
        const pipelineStdout = await resolvePipelineStdout(executed.result);
        const incompletePipelineInput = stepIndex < steps.length - 1 && pipelineStdout === undefined;
        result = incompletePipelineInput
            ? rejectIncompletePipelineOutput(executed.result)
            : executed.result;
        executed.result = result;
        if (incompletePipelineInput) {
            addResultFailure(failures, executed);
            return {
                branches,
                commands,
                criticalFailure: true,
                failureScope: "root",
                failures,
                result,
            };
        }
        if (result.code !== 0) {
            const failureScope = maxFailureScope(executed.failureScope, executed.criticalFailure ? "root" : undefined, getFailureScope(step), getFailureScope(normalized), isRoot && steps.length === 1 ? "root" : undefined);
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
        nextStdin = pipelineStdout;
    }
    return { branches, commands, failures, result: result };
}
async function executeTemplateSteps(cfg, params, exec, cwd, signal) {
    return executeTemplateConfig(createTemplateConfig(cfg), {}, params, exec, cwd, signal, undefined, true, undefined);
}
function getCaptureDetails(result) {
    return {
        stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
        stdoutCapturedBytes: Buffer.byteLength(result.stdout),
        stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
        stderrCapturedBytes: Buffer.byteLength(result.stderr),
        ...(result.stdoutFile ? { stdoutFile: result.stdoutFile } : {}),
        ...(result.stderrFile ? { stderrFile: result.stderrFile } : {}),
        ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
        ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
    };
}
export async function executeRegisteredTool(cfg, params, exec, cwd, signal) {
    const executed = await executeTemplateSteps(cfg, Schema.normalizeRuntimeValues(params, cfg.argTypes), exec, cwd, signal);
    const command = formatCommandDetail(executed.commands);
    const result = executed.result;
    const softQuorum = createSoftQuorum(executed.branches);
    if (result.code !== 0) {
        const formatted = formatFailureOutput(cfg.name, result.code, result.killed, result.stdout, result.stderr);
        throw Object.assign(new Error(formatted.text), {
            details: {
                branches: executed.branches,
                code: result.code,
                command,
                fullOutputPath: result.stdoutFile ?? formatted.fullOutputPath,
                killed: result.killed,
                ...getCaptureDetails(result),
                ...(executed.failures.length > 0
                    ? { nonCriticalFailures: executed.failures }
                    : {}),
                ...(softQuorum ? { softQuorum } : {}),
                failureReason: getExecutionFailureReason(executed.branches, softQuorum, result.stderr),
                template: cfg.template,
                tool: cfg.name,
                truncated: formatted.truncated,
            },
        });
    }
    const formatted = formatOutput(cfg.name, "stdout", result.stdout);
    const templateWarnings = CommandTemplates.getCommandTemplateWarnings(createTemplateConfig(cfg));
    return {
        content: [textContent(formatted.text)],
        details: {
            code: result.code,
            command,
            fullOutputPath: result.stdoutFile ?? formatted.fullOutputPath,
            killed: result.killed,
            launch_kind: "tool",
            ...getCaptureDetails(result),
            ...(executed.branches.length > 0 ? { branches: executed.branches } : {}),
            ...(executed.failures.length > 0
                ? { nonCriticalFailures: executed.failures }
                : {}),
            ...(softQuorum ? { softQuorum } : {}),
            template: cfg.template,
            ...(templateWarnings.length > 0 ? { templateWarnings } : {}),
            tool: cfg.name,
            truncated: formatted.truncated,
        },
    };
}
