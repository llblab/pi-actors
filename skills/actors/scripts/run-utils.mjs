#!/usr/bin/env node

/** Actor-owned Run summary utilities. */

// @ts-nocheck

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.error(`Usage:
  run-utils.mjs run-summary <state-root>
  run-utils.mjs run-ops-snapshot <state-root> <run-id> [lines] [stale-minutes]`);
}

function walkFiles(dir, maxDepth = 2, depth = 0, out = []) {
  if (depth > maxDepth || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, maxDepth, depth + 1, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function getRunStatus(run, progress, result) {
  if (progress?.phase) return progress.phase;
  if (result?.code !== undefined) return result.code === 0 ? "done" : "failed";
  return run.status ?? "unknown";
}

function collectRunSummary(rootValue) {
  const root = resolve(rootValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const files = walkFiles(root, 2).filter((file) => basename(file) === "run.json");
  const rows = [];
  for (const file of files) {
    const run = readJson(file);
    if (!run) {
      rows.push({ run: relative(root, file), status: "invalid-json", recipe: "", updated: "" });
      continue;
    }
    const runDir = dirname(file);
    const progress = readJson(join(runDir, "progress.json"));
    const result = readJson(join(runDir, "result.json"));
    rows.push({
      run: run.run_id ?? run.run ?? relative(root, file).split(sep)[0],
      status: getRunStatus(run, progress, result),
      recipe: run.recipe ?? run.recipe_file ?? "",
      updated:
        progress?.updatedAt ??
        result?.completedAt ??
        run.updated_at ??
        run.completed_at ??
        run.started_at ??
        "",
    });
  }
  rows.sort((a, b) => `${a.status}:${a.run}`.localeCompare(`${b.status}:${b.run}`));
  return rows;
}

function tailJsonl(fileValue, linesValue = "80") {
  const file = resolve(fileValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  if (!existsSync(file)) return [];
  const lines = Number.parseInt(linesValue, 10);
  const count = Number.isFinite(lines) && lines > 0 ? lines : 80;
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

function runOpsSnapshot(
  rootValue,
  runIdValue = "music",
  linesValue = "80",
  staleMinutesValue = "60",
) {
  const runs = collectRunSummary(rootValue);
  const root = resolve(rootValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const inspectedRun = String(runIdValue || "music");
  const staleMs = Number(staleMinutesValue) * 60 * 1000;
  const now = Date.now();
  const recommendations = runs.flatMap((run) => {
    const updatedMs = Date.parse(run.updated || "");
    const stale =
      Number.isFinite(updatedMs) &&
      Number.isFinite(staleMs) &&
      now - updatedMs > staleMs;
    if (run.status === "running" && stale) {
      return [{
        run: run.run,
        reason: "running-stale",
        suggested_inspect: { target: `run:${run.run}`, view: "control" },
      }];
    }
    if (["failed", "exited", "killed"].includes(run.status)) {
      return [{
        run: run.run,
        reason: `terminal-${run.status}`,
        suggested_inspect: { target: `run:${run.run}`, view: "trace" },
      }];
    }
    return [];
  });
  console.log(JSON.stringify({
    runs,
    inspectedRun,
    trace: tailJsonl(join(root, inspectedRun, "trace.jsonl"), linesValue),
    recommendations,
  }, null, 2));
}

function runSummary(rootValue) {
  console.log(JSON.stringify(collectRunSummary(rootValue), null, 2));
}

function run(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "run-summary") {
    runSummary(args[0] ?? "~/.pi/agent/tmp/pi-actors/runs");
    return;
  }
  if (command === "run-ops-snapshot") {
    runOpsSnapshot(
      args[0] ?? "~/.pi/agent/tmp/pi-actors/runs",
      args[1] ?? "music",
      args[2],
      args[3],
    );
    return;
  }
  usage();
  fail(`Unknown command: ${command ?? ""}`);
}

try {
  run();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
