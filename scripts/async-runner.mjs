#!/usr/bin/env node

/**
 * Detached async-runner executable.
 *
 * Owns the run child-process control loop directly. Reusable runtime
 * primitives stay in lib/; this script should remain understandable without
 * chasing a one-off lib entrypoint domain.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function importRuntimeModule(name) {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", `${name}.js`);
  const source = join(root, "lib", `${name}.ts`);
  return await import(
    pathToFileURL(existsSync(compiled) ? compiled : source).href
  );
}

const { appendRecipeContextToPiArgs, materializePiPrintPromptArg } =
  await importRuntimeModule("recipes-context");
const { buildReviewPreflightDiagnostic, formatReviewPreflightDiagnostic } =
  await importRuntimeModule("preflight-diagnostics");
const { execCommandTemplate } = await importRuntimeModule("command-templates");
const { executeRegisteredTool } = await importRuntimeModule("execution");
const { writeJsonAtomic } = await importRuntimeModule("file-state");

function quoteCommandDetailPart(value) {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_/:=.,@%+\-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function formatCommandDetail(command, args) {
  return [command, ...args].map(quoteCommandDetailPart).join(" ");
}

function summarizeCommandDetail(commandDetail) {
  return commandDetail.length > 160
    ? `${commandDetail.slice(0, 157)}...`
    : commandDetail;
}

export async function runAsyncRunner(stateDir = process.argv[2]) {
  if (!stateDir) throw new Error("missing state dir");

  const runPath = join(stateDir, "run.json");
  const progressPath = join(stateDir, "progress.json");
  const resultPath = join(stateDir, "result.json");
  const eventsPath = join(stateDir, "events.jsonl");
  const outboxPath = join(stateDir, "outbox.jsonl");
  const stdoutPath = join(stateDir, "stdout.log");
  const stderrPath = join(stateDir, "stderr.log");
  const meta = JSON.parse(readFileSync(runPath, "utf8"));

  function event(name, data = {}) {
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ event: name, ts: new Date().toISOString(), ...data })}\n`,
    );
  }

  function outbox(name, summary, data = {}, delivery = "log", level = "info") {
    appendFileSync(
      outboxPath,
      `${JSON.stringify({ body: data, data, delivery, event: name, from: `run:${meta.run}`, level, summary, to: "coordinator", ts: new Date().toISOString(), type: name })}\n`,
    );
  }

  function progress(phase, extra = {}) {
    writeJsonAtomic(progressPath, {
      ...(meta.model_policy ? { model_policy: meta.model_policy } : {}),
      phase,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  let activeSubagents = 0;
  let completedSubagents = 0;
  let promptCounter = 0;
  const subagentFailures = [];

  function getCommandDoneDelivery(result) {
    return result.code !== 0 || activeSubagents > 0 ? "followup" : "log";
  }

  function progressRunning() {
    progress("running", {
      activeSubagents,
      completed: completedSubagents,
      failures: subagentFailures,
    });
  }

  function promptFilePath() {
    promptCounter += 1;
    const dir = join(stateDir, "prompts");
    mkdirSync(dir, { recursive: true });
    return join(dir, `command-${String(promptCounter).padStart(3, "0")}.md`);
  }

  function readPromptText(promptFile) {
    if (!promptFile) return undefined;
    try {
      return readFileSync(promptFile, "utf8");
    } catch {
      return undefined;
    }
  }

  async function observedExec(command, args, options) {
    const contextArgs = appendRecipeContextToPiArgs(
      command,
      args,
      meta.recipe_context_records,
      options?.actorRecipeContext,
    );
    const materialized = materializePiPrintPromptArg(
      command,
      contextArgs,
      promptFilePath,
    );
    const execArgs = materialized.args;
    const commandDetail = formatCommandDetail(command, execArgs);
    activeSubagents += 1;
    event("command.start", {
      activeSubagents,
      command: commandDetail,
      ...(materialized.promptFile ? { prompt_file: materialized.promptFile } : {}),
      ...(materialized.promptBytes ? { prompt_bytes: materialized.promptBytes } : {}),
    });
    progressRunning();
    let result = await execCommandTemplate(command, execArgs, options);
    const preflightDiagnostic = result.code !== 0
      ? buildReviewPreflightDiagnostic({
          args: execArgs,
          code: result.code,
          killed: result.killed,
          ...(materialized.promptFile ? { promptFile: materialized.promptFile } : {}),
          promptText: readPromptText(materialized.promptFile),
          stderr: result.stderr,
          stdout: result.stdout,
        })
      : undefined;
    if (preflightDiagnostic) {
      result = {
        ...result,
        stderr: [
          result.stderr,
          formatReviewPreflightDiagnostic(preflightDiagnostic),
        ].filter(Boolean).join("\n"),
      };
    }
    activeSubagents = Math.max(0, activeSubagents - 1);
    completedSubagents += 1;
    if (result.code !== 0) {
      subagentFailures.push({
        code: result.code,
        command: commandDetail,
        killed: result.killed,
        ...(materialized.promptFile ? { prompt_file: materialized.promptFile } : {}),
        ...(preflightDiagnostic ? { preflight: preflightDiagnostic } : {}),
      });
    }
    event("command.done", {
      activeSubagents,
      code: result.code,
      command: commandDetail,
      killed: result.killed,
      ...(materialized.promptFile ? { prompt_file: materialized.promptFile } : {}),
      ...(materialized.promptBytes ? { prompt_bytes: materialized.promptBytes } : {}),
      ...(preflightDiagnostic ? { preflight: preflightDiagnostic } : {}),
    });
    outbox(
      "command.done",
      `Command ${summarizeCommandDetail(commandDetail)} completed with code ${result.code}`,
      {
        activeSubagents,
        ...(meta.artifacts ? { artifacts: meta.artifacts } : {}),
        run_files: [stdoutPath, stderrPath, resultPath, eventsPath, outboxPath],
        code: result.code,
        command: commandDetail,
        killed: result.killed,
        ...(materialized.promptFile ? { prompt_file: materialized.promptFile } : {}),
        ...(materialized.promptBytes ? { prompt_bytes: materialized.promptBytes } : {}),
        ...(preflightDiagnostic ? { preflight: preflightDiagnostic } : {}),
      },
      getCommandDoneDelivery(result),
      result.code === 0 ? "info" : "error",
    );
    progressRunning();
    return result;
  }

  try {
    event("run.runner.start", { pid: process.pid });
    progressRunning();
    const result = await executeRegisteredTool(
      {
        name: "run_actor",
        description: "Detached command-template run actor",
        template: meta.template,
        args: [],
        defaults: {},
      },
      meta.values || {},
      observedExec,
      meta.cwd,
    );
    const text = result.content?.[0]?.text || "";
    appendFileSync(stdoutPath, text);
    writeJsonAtomic(resultPath, {
      code: result.details.code,
      command: result.details.command,
      killed: result.details.killed,
      ...(meta.model_policy ? { model_policy: meta.model_policy } : {}),
      truncated: result.details.truncated,
      completedAt: new Date().toISOString(),
    });
    progress("done", {
      completed: 1,
      failures: result.details.nonCriticalFailures || [],
    });
    event("run.done", { code: result.details.code });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error && typeof error === "object" ? error.details : undefined;
    appendFileSync(stderrPath, `${message}\n`);
    writeJsonAtomic(resultPath, {
      code: typeof details?.code === "number" ? details.code : 1,
      error: message,
      killed: Boolean(details?.killed),
      ...(Array.isArray(details?.branches) ? { branches: details.branches } : {}),
      ...(details?.failureReason ? { failure_reason: details.failureReason } : {}),
      ...(meta.model_policy ? { model_policy: meta.model_policy } : {}),
      ...(details?.softQuorum ? { soft_quorum: details.softQuorum } : {}),
      completedAt: new Date().toISOString(),
    });
    progress("failed", {
      completed: 0,
      failures: Array.isArray(details?.branches) && details.branches.length > 0
        ? details.branches
        : [{ message }],
      ...(details?.failureReason ? { failureReason: details.failureReason } : {}),
    });
    event("run.failed", {
      error: message,
      ...(details?.failureReason ? { failure_reason: details.failureReason } : {}),
    });
    throw error;
  }
}

try {
  await runAsyncRunner(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
