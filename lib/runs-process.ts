/**
 * Async run process identity helpers.
 * Owns cross-platform liveness and stable runner process identity proofs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

export interface RunProcessIdentity {
  command: string;
  cwd?: string;
  platform: NodeJS.Platform;
  start_time: string;
}

export type RunProcessIdentityStatus =
  | "valid"
  | "dead_pid"
  | "owner_mismatch"
  | "unsupported_proof";

export interface RunProcessIdentityResult {
  status: RunProcessIdentityStatus;
  valid: boolean;
}

type ProcessIdentityReader = (
  pid: number,
  runtimePlatform: NodeJS.Platform,
) => RunProcessIdentity | undefined;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLinuxIdentity(pid: number): RunProcessIdentity | undefined {
  if (!existsSync(`/proc/${pid}`)) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) return undefined;
    return {
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
      cwd: readlinkSync(`/proc/${pid}/cwd`),
      platform: "linux",
      start_time: startTime,
    };
  } catch {
    return undefined;
  }
}

function readDarwinIdentity(pid: number): RunProcessIdentity | undefined {
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^(.{24})\s+(.+)$/s);
  if (!match) return undefined;
  return {
    command: match[2].trim(),
    platform: "darwin",
    start_time: match[1].trim(),
  };
}

function readWindowsIdentity(pid: number): RunProcessIdentity | undefined {
  const command = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\";`,
    "if ($null -eq $p) { exit 3 };",
    "$p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ].join(" ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof value.CreationDate !== "string") return undefined;
    const executable = typeof value.ExecutablePath === "string" ? value.ExecutablePath : "";
    const commandLine = typeof value.CommandLine === "string" ? value.CommandLine : "";
    return {
      command: `${executable}\n${commandLine}`.trim(),
      platform: "win32",
      start_time: value.CreationDate,
    };
  } catch {
    return undefined;
  }
}

export function readProcessIdentity(
  pid: number,
  runtimePlatform: NodeJS.Platform = platform(),
): RunProcessIdentity | undefined {
  if (runtimePlatform === "linux") return readLinuxIdentity(pid);
  if (runtimePlatform === "darwin") return readDarwinIdentity(pid);
  if (runtimePlatform === "win32") return readWindowsIdentity(pid);
  return undefined;
}

export function captureRunProcessIdentity(
  pid: number,
  cwd: string,
  stateDir: string,
  runnerPath: string,
  runtimePlatform: NodeJS.Platform = platform(),
  reader: ProcessIdentityReader = readProcessIdentity,
): RunProcessIdentity | undefined {
  const identity = reader(pid, runtimePlatform);
  if (!identity) return undefined;
  if (!identity.command.includes(runnerPath) || !identity.command.includes(stateDir)) {
    return undefined;
  }
  const resolvedCwd = resolve(cwd);
  const canonicalCwd = existsSync(resolvedCwd)
    ? realpathSync.native(resolvedCwd)
    : resolvedCwd;
  const expectedCwd =
    runtimePlatform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
  const actualCwd =
    runtimePlatform === "win32" && identity.cwd
      ? identity.cwd.toLowerCase()
      : identity.cwd;
  if (actualCwd && actualCwd !== expectedCwd) return undefined;
  return identity;
}

export function verifyRunProcessIdentity(
  pid: number,
  expected: RunProcessIdentity | undefined,
  runtimePlatform: NodeJS.Platform = platform(),
  reader: ProcessIdentityReader = readProcessIdentity,
  alive: (pid: number) => boolean = isAlive,
): RunProcessIdentityResult {
  if (!alive(pid)) return { status: "dead_pid", valid: false };
  if (!expected || expected.platform !== runtimePlatform) {
    return { status: "unsupported_proof", valid: false };
  }
  const current = reader(pid, runtimePlatform);
  if (!current) return { status: "unsupported_proof", valid: false };
  const valid =
    current.start_time === expected.start_time &&
    current.command === expected.command &&
    current.cwd === expected.cwd;
  return { status: valid ? "valid" : "owner_mismatch", valid };
}

export function isWithinRunnerIdentityGrace(
  meta: Record<string, unknown>,
  graceMs: number,
): boolean {
  const createdAt =
    typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
  return (
    Number.isFinite(createdAt) &&
    Date.now() - createdAt >= 0 &&
    Date.now() - createdAt <= graceMs
  );
}
