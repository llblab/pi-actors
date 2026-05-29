#!/usr/bin/env node

/**
 * Detached async-runner executable.
 *
 * Owns the run child-process control loop directly. Reusable runtime
 * primitives stay in lib/; this script should remain understandable without
 * chasing a one-off lib entrypoint domain.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

const { appendRecipeContextToPiArgs } =
  await importRuntimeModule("recipes-context");
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
      phase,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  let activeSubagents = 0;
  let completedSubagents = 0;
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

  async function observedExec(command, args, options) {
    const commandDetail = formatCommandDetail(command, args);
    const execArgs = appendRecipeContextToPiArgs(
      command,
      args,
      meta.recipe_context_records,
      options?.actorRecipeContext,
    );
    activeSubagents += 1;
    event("command.start", { activeSubagents, command: commandDetail });
    progressRunning();
    const result = await execCommandTemplate(command, execArgs, options);
    activeSubagents = Math.max(0, activeSubagents - 1);
    completedSubagents += 1;
    if (result.code !== 0) {
      subagentFailures.push({
        code: result.code,
        command: commandDetail,
        killed: result.killed,
      });
    }
    event("command.done", {
      activeSubagents,
      code: result.code,
      command: commandDetail,
      killed: result.killed,
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
    appendFileSync(stderrPath, `${message}\n`);
    writeJsonAtomic(resultPath, {
      code: 1,
      error: message,
      killed: false,
      completedAt: new Date().toISOString(),
    });
    progress("failed", { completed: 0, failures: [{ message }] });
    event("run.failed", { error: message });
    throw error;
  }
}

try {
  await runAsyncRunner(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
