/**
 * Command-template async job primitives
 * Owns detached job state, observation, log tailing, listing, and cancellation safety
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { CommandTemplateValue } from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import { writeJsonAtomic } from "./config.ts";
import * as Paths from "./paths.ts";

export interface JobStartParams {
  file?: string;
  job?: string;
  state_dir?: string;
  stateDir?: string;
  template?: CommandTemplateValue;
  tool?: string;
  values?: Record<string, unknown>;
  cwd?: string;
}

export interface JobMeta {
  argv: string[];
  createdAt: string;
  cwd: string;
  job: string;
  pid: number;
  stateDir: string;
  status: "running" | "done" | "exited";
  template: CommandTemplateValue;
  tool?: string;
  values: Record<string, unknown>;
}

const DEFAULT_STATE_ROOT = Paths.getJobStateRoot();
const DEFAULT_TEMPLATE_ROOT = Paths.getJobTemplateRoot();
const RUNNER_PATH = new URL("../scripts/template-job-runner.mjs", import.meta.url).pathname;

function safeJobId(value: string | undefined): string {
  const job = (value || `job-${Date.now()}`).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(job)) throw new Error("Job id may contain only letters, numbers, dot, underscore, and dash.");
  return job;
}

function resolveJobTemplate(
  params: JobStartParams,
  tools?: Map<string, RegisteredTool>,
): { template: CommandTemplateValue; tool?: string } {
  if (params.template) return { template: params.template };
  if (!params.tool) throw new Error("template_job action=start requires file, template, or tool.");
  const cfg = tools?.get(params.tool);
  if (!cfg) throw new Error(`Registered tool not found: ${params.tool}`);
  return { template: cfg.template, tool: cfg.name };
}

function resolveStateDir(params: JobStartParams, job: string): string {
  const raw = params.state_dir || params.stateDir;
  return resolve(raw || join(DEFAULT_STATE_ROOT, job));
}

function resolveJobTemplateFile(file: string): string {
  if (file.includes("/")) return resolve(file);
  return resolve(join(DEFAULT_TEMPLATE_ROOT, file.endsWith(".json") ? file : `${file}.json`));
}

function readJobTemplateFile(file: string): JobStartParams {
  const path = resolveJobTemplateFile(file);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { ...(raw as JobStartParams), file: path };
}

function getJobIdFromFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const name = basename(file, extname(file));
  return name || undefined;
}

function resolveStartParams(params: JobStartParams): JobStartParams {
  if (!params.file) return params;
  const fileParams = readJobTemplateFile(params.file);
  return {
    ...fileParams,
    ...params,
    job: params.job || fileParams.job || getJobIdFromFile(fileParams.file),
    values: { ...(fileParams.values ?? {}), ...(params.values ?? {}) },
  };
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidMatchesJob(pid: number, cwd: string, stateDir: string): boolean {
  try {
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return procCwd === resolve(cwd) && cmdline.includes(RUNNER_PATH) && cmdline.includes(stateDir);
  } catch {
    return false;
  }
}

function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trimEnd();
  if (!content) return "";
  return content.split("\n").slice(-lines).join("\n");
}

export function startJob(
  params: JobStartParams,
  cwd: string,
  tools?: Map<string, RegisteredTool>,
): JobMeta {
  const startParams = resolveStartParams(params);
  const resolved = resolveJobTemplate(startParams, tools);
  const job = safeJobId(startParams.job);
  const stateDir = resolveStateDir(startParams, job);
  mkdirSync(stateDir, { recursive: true });
  const stdout = join(stateDir, "stdout.log");
  const stderr = join(stateDir, "stderr.log");
  const outFd = openSync(stdout, "a");
  const errFd = openSync(stderr, "a");
  const argv = ["--experimental-strip-types", RUNNER_PATH, stateDir];
  const meta: JobMeta = {
    argv: [process.execPath, ...argv],
    createdAt: new Date().toISOString(),
    cwd,
    job,
    pid: 0,
    stateDir,
    status: "running",
    template: resolved.template,
    ...(resolved.tool ? { tool: resolved.tool } : {}),
    values: startParams.values || {},
  };
  writeJsonAtomic(join(stateDir, "job.json"), meta);
  const child = spawn(process.execPath, argv, {
    cwd,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  meta.pid = child.pid ?? 0;
  writeJsonAtomic(join(stateDir, "job.json"), meta);
  writeJsonAtomic(join(stateDir, "progress.json"), {
    completed: 0,
    failures: [],
    phase: "starting",
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({ event: "job.start", job, pid: meta.pid, ts: new Date().toISOString() })}\n`, { flag: "a" });
  child.unref();
  return meta;
}

export function getJobStatus(jobOrDir: string): Record<string, unknown> {
  const stateDir = resolve(jobOrDir.includes("/") ? jobOrDir : join(DEFAULT_STATE_ROOT, safeJobId(jobOrDir)));
  const meta = readJson(join(stateDir, "job.json"));
  if (!meta) throw new Error(`Job not found: ${jobOrDir}`);
  const result = readJson(join(stateDir, "result.json"));
  const pid = Number(meta.pid || 0);
  const status = result ? "done" : isAlive(pid) ? "running" : "exited";
  return {
    ...meta,
    eventsFile: join(stateDir, "events.jsonl"),
    progress: readJson(join(stateDir, "progress.json")) || null,
    result: result || null,
    stderrLog: join(stateDir, "stderr.log"),
    stdoutLog: join(stateDir, "stdout.log"),
    status,
  };
}

export function listJobs(stateRoot = DEFAULT_STATE_ROOT): Array<Record<string, unknown>> {
  if (!existsSync(stateRoot)) return [];
  const jobs: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const stateDir = join(stateRoot, entry.name);
      const status = getJobStatus(stateDir);
      jobs.push({ job: status.job, stateDir, status: status.status });
    } catch {
      // Ignore malformed job dirs.
    }
  }
  return jobs;
}

export function tailJob(jobOrDir: string, lines = 40): string {
  const status = getJobStatus(jobOrDir);
  const stateDir = String(status.stateDir);
  const events = tailFile(join(stateDir, "events.jsonl"), lines);
  if (events) return events;
  return tailFile(join(stateDir, "stdout.log"), lines) || tailFile(join(stateDir, "stderr.log"), lines);
}

export function cancelJob(jobOrDir: string): Record<string, unknown> {
  const status = getJobStatus(jobOrDir);
  const pid = Number(status.pid || 0);
  const stateDir = String(status.stateDir);
  if (status.status !== "running") return { cancelled: false, reason: "not running", status };
  if (!pid || !isAlive(pid)) return { cancelled: false, reason: "pid not alive", status };
  if (!pidMatchesJob(pid, String(status.cwd), stateDir)) {
    return { cancelled: false, reason: "pid owner mismatch", status };
  }
  process.kill(pid, "SIGTERM");
  writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({ event: "job.cancel", pid, ts: new Date().toISOString() })}\n`, { flag: "a" });
  return { cancelled: true, pid, stateDir };
}
