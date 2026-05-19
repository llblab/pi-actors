#!/usr/bin/env node

/**
 * Detached async-runner.
 *
 * This process is intentionally thin: the parent tool prepares state files and
 * starts this script in the background; this script loads the recorded run,
 * executes its command template, and writes ordinary files that status/tail/list
 * tools can inspect later.
 *
 * Keep orchestration policy out of this file.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.argv[2];
if (!stateDir) {
  console.error("missing state dir");
  process.exit(1);
}
const { executeRegisteredTool } = await import("../lib/execution.ts");
const { execCommandTemplate } = await import("../lib/command-templates.ts");
const { writeJsonAtomic } = await import("../lib/config.ts");
const runPath = join(stateDir, "run.json");
const progressPath = join(stateDir, "progress.json");
const resultPath = join(stateDir, "result.json");
const eventsPath = join(stateDir, "events.jsonl");
const outboxPath = join(stateDir, "outbox.jsonl");
const stdoutPath = join(stateDir, "stdout.log");
const stderrPath = join(stateDir, "stderr.log");
const meta = JSON.parse(readFileSync(runPath, "utf8"));

/**
 * Appends one lifecycle event.
 *
 * events.jsonl is append-only so observers can tail transitions even while the
 * run is still running.
 */
function event(name, data = {}) {
  appendFileSync(
    eventsPath,
    `${JSON.stringify({ event: name, ts: new Date().toISOString(), ...data })}\n`,
  );
}
function normalizeDelivery(value) {
  return value === "notify" || value === "followup" ? value : "log";
}
function resolveTemplateString(value) {
  if (typeof value !== "string") return undefined;
  return value.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, name) =>
    meta.values?.[name] === undefined || meta.values?.[name] === null
      ? ""
      : String(meta.values[name]),
  );
}
function getEventDelivery(name) {
  return normalizeDelivery(resolveTemplateString(meta.events?.[name]?.delivery));
}
function outbox(name, summary, data = {}, delivery = "log", level = "info") {
  appendFileSync(
    outboxPath,
    `${JSON.stringify({ body: data, data, delivery, event: name, from: `run:${meta.run}`, level, summary, to: "coordinator", ts: new Date().toISOString(), type: name })}\n`,
  );
}
/**
 * Writes the compact status snapshot.
 *
 * progress.json is rewritten atomically because observers may read it
 * concurrently.
 */
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
function progressRunning() {
  progress("running", {
    activeSubagents,
    completed: completedSubagents,
    failures: subagentFailures,
  });
}
async function observedExec(command, args, options) {
  activeSubagents += 1;
  event("command.start", { activeSubagents, command });
  progressRunning();
  const result = await execCommandTemplate(command, args, options);
  activeSubagents = Math.max(0, activeSubagents - 1);
  completedSubagents += 1;
  if (result.code !== 0) {
    subagentFailures.push({ code: result.code, command, killed: result.killed });
  }
  event("command.done", {
    activeSubagents,
    code: result.code,
    command,
    killed: result.killed,
  });
  outbox(
    "command.done",
    `Command ${command} completed with code ${result.code}`,
    {
      activeSubagents,
      ...(meta.artifacts ? { artifacts: meta.artifacts } : {}),
      run_files: [stdoutPath, stderrPath, resultPath, eventsPath, outboxPath],
      code: result.code,
      command,
      killed: result.killed,
    },
    getEventDelivery("command.done"),
    result.code === 0 ? "info" : "error",
  );
  progressRunning();
  return result;
}
try {
  event("run.runner.start", { pid: process.pid });
  progressRunning();
  /**
   * Reuse the same registered-tool execution path as foreground tools.
   *
   * The synthetic tool name is only for reporting; meta.template is the real
   * work.
   */
  const result = await executeRegisteredTool(
    {
      name: "async_run",
      description: "Detached command-template async run",
      template: meta.template,
      args: [],
      defaults: {},
    },
    meta.values || {},
    observedExec,
    meta.cwd,
  );
  /**
   * Tool output is already formatted/truncated by the shared execution layer.
   * The runner persists that agent-facing text for later tail/status analysis.
   */
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
  /**
   * Represent failure in every observable channel:
   *
   * - stderr.log for humans
   * - result.json for structured readers
   * - progress.json for status
   * - events.jsonl for tail/watch flows
   */
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
  process.exit(1);
}
