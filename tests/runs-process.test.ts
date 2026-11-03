/**
 * Cross-platform run process identity regression tests.
 * Covers capture, conservative liveness, and signal-independent process-exit evidence.
 */

import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureRunProcessIdentity,
  captureSpawnedRunProcessIdentity,
  isAlive,
  observeRunProcessExit,
  readProcessIdentity,
  runProcessIdentityDigest,
  readWindowsProcessIdentities,
  readProcessLiveness,
  readProcessGroupLiveness,
  type RunProcessIdentity,
  verifyRunProcessIdentity,
} from "../lib/runs-process.ts";
import { signalOwnedRunProcess } from "../lib/runs-control.ts";
import { readActiveOwnedRunState } from "../lib/runs-start.ts";

test("Windows UTF8 producers precede output and preserve exact identities without legacy aliases", (t) => {
  const encoding = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true);";
  const commands: string[] = [];
  let row = { ProcessId: 42, CreationDate: "/Date(0)/", ExecutablePath: "C:\\node.exe", CommandLine: "" };
  const hook = t.mock.method(childProcess, "spawnSync", (_file: string, args: string[], options: Record<string, unknown>) => {
    const command = args[3]!;
    commands.push(command);
    assert.equal(options.encoding, "utf8");
    assert.equal(command.split(encoding).length, 2);
    assert.ok(command.indexOf(encoding) < command.indexOf("ConvertTo-Json"));
    const json = JSON.stringify(command.includes("-InputObject") ? [row] : row);
    return { status: 0, signal: null, stdout: Buffer.from(json, "utf8").toString("utf8") };
  });
  syncBuiltinESMExports();
  try {
    for (const text of ['ascii "quoted" \\ segment', '漢字😀 "quoted" \\ segment', 'e\u0301É\r\nα']) {
      row = { ...row, CommandLine: text };
      const expected: RunProcessIdentity = { platform: "win32", start_time: row.CreationDate, command: `${row.ExecutablePath}\n${text}` };
      const scalar = readProcessIdentity(42, "win32")!;
      const shared = readWindowsProcessIdentities([42])!.get(42)!;
      assert.deepEqual(scalar, expected); assert.deepEqual(shared, expected);
      assert.equal(runProcessIdentityDigest(scalar), runProcessIdentityDigest(expected));
      assert.equal(runProcessIdentityDigest(shared), runProcessIdentityDigest(expected));
      const saved = Object.freeze({ ...expected, command: expected.command.replace(/漢字😀/u, "???") });
      const bytes = JSON.stringify(saved);
      if (saved.command !== expected.command) {
        assert.notEqual(runProcessIdentityDigest(saved), runProcessIdentityDigest(scalar));
        assert.deepEqual(verifyRunProcessIdentity(42, saved, "win32", () => scalar, () => true), { status: "owner_mismatch", valid: false });
        assert.deepEqual(verifyRunProcessIdentity(42, saved, "win32", () => undefined, () => true), { status: "unsupported_proof", valid: false });
      }
      assert.equal(JSON.stringify(saved), bytes);
    }
    assert.equal(commands.length, 6);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows CIM chunks preserve scalar bytes and optional fields while rejecting incomplete or uncorrelated output", (t) => {
  const date = "/Date(1786000000000)/";
  const optional = [{}, { ExecutablePath: null, CommandLine: null }, { ExecutablePath: 17, CommandLine: false },
    { ExecutablePath: " C:\\node.exe ", CommandLine: " node\r\nquoted \"α\"  " }];
  let output: unknown; let result: Record<string, unknown> = {}; let calls = 0;
  const hook = t.mock.method(childProcess, "spawnSync", (file: string, args: string[], options: Record<string, unknown>) => {
    calls++; assert.equal(file, "powershell.exe"); assert.equal(options.windowsHide, true);
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.ok(args[3].length <= 4096); assert.doesNotMatch(args[3], /EncodedCommand/);
    if (args[3].includes("-InputObject")) {
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.match(args[3], /^\$ErrorActionPreference = "Stop"; \$p = Get-CimInstance Win32_Process -Property ProcessId,CreationDate,ExecutablePath,CommandLine -Filter "ProcessId = [1-9][0-9]*(?: OR ProcessId = [1-9][0-9]*){0,63}"; \[Console\]::OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false, \$true\); ConvertTo-Json -InputObject @\(\$p \| Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine\) -Compress$/);
      assert.doesNotMatch(args[3], /[^\x00-\x7f]/);
    } else assert.equal(args[3], '$p = Get-CimInstance Win32_Process -Property CreationDate,ExecutablePath,CommandLine -Filter "ProcessId = 42"; if ($null -eq $p) { exit 3 }; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true); $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress');
    return { status: 0, signal: null, stdout: typeof output === "string" ? output : JSON.stringify(output), ...result };
  });
  syncBuiltinESMExports();
  try {
    for (const fields of optional) {
      output = { CreationDate: date, ...fields };
      const scalar = readProcessIdentity(42, "win32");
      output = [{ ProcessId: 42, CreationDate: date, ...fields }];
      assert.deepEqual(readWindowsProcessIdentities([42])?.get(42), scalar);
      assert.equal(scalar?.start_time, date); assert.equal(scalar?.cwd, undefined);
    }
    const row = { ProcessId: 42, CreationDate: date, CommandLine: "node" };
    for (const invalid of [[row, row], [{ ...row, ProcessId: 43 }], [{ ...row, ProcessId: "42" }],
      [{ ...row, CreationDate: null }], [null], {}, "[] trailing", "[", " ".repeat(1024 * 1024) + "[]"]) {
      output = invalid; assert.equal(readWindowsProcessIdentities([42]), undefined);
    }
    output = []; assert.deepEqual(readWindowsProcessIdentities([42]), new Map());
    for (const failure of [{ status: 1 }, { error: new Error("maxBuffer") }, { signal: "SIGTERM" }, { stdout: null }]) {
      result = failure; assert.equal(readWindowsProcessIdentities([42]), undefined);
    }
    result = {}; output = [];
    const before = calls;
    for (const pids of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [42, 42], Array.from({ length: 65 }, (_, i) => i + 1)]) {
      assert.equal(readWindowsProcessIdentities(pids), undefined);
    }
    assert.equal(calls, before);
    assert.deepEqual(readWindowsProcessIdentities(Array.from({ length: 64 }, (_, i) => Number.MAX_SAFE_INTEGER - i)), new Map());
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test("Windows scalar acquisitions stay fresh and preserve decoding and exact spawn failures", (t) => {
  let calls = 0; let value: unknown; let fault: unknown; let throws = false;
  const hook = t.mock.method(childProcess, "spawnSync", (file: string, args: string[], options: unknown) => {
    calls++;
    assert.equal(file, "powershell.exe");
    assert.deepEqual(args, ["-NoProfile", "-NonInteractive", "-Command",
      '$p = Get-CimInstance Win32_Process -Property CreationDate,ExecutablePath,CommandLine -Filter "ProcessId = 43"; if ($null -eq $p) { exit 3 }; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true); $p | Select-Object CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress']);
    assert.deepEqual(options, { encoding: "utf8", windowsHide: true });
    if (throws) throw fault;
    return value;
  });
  syncBuiltinESMExports();
  try {
    for (const date of ["first", "second"]) {
      value = { status: 0, stdout: JSON.stringify({ CreationDate: date, ExecutablePath: " C:\\node.exe ", CommandLine: " node\r\nα  " }) };
      const before = calls;
      assert.deepEqual(readProcessIdentity(43, "win32"), { platform: "win32", start_time: date, command: "C:\\node.exe \n node\r\nα" });
      assert.equal(calls, before + 1);
    }
    for (const fields of [{}, { ExecutablePath: null, CommandLine: false }, { ExecutablePath: 17, CommandLine: null }]) {
      value = { status: 0, stdout: JSON.stringify({ CreationDate: "", ...fields }) };
      assert.deepEqual(readProcessIdentity(43, "win32"), { platform: "win32", start_time: "", command: "" });
    }
    for (const stdout of ["[", "{}", "null", "[]", '{"CreationDate":null}', '{"CreationDate":17}']) {
      value = { status: 0, stdout }; assert.equal(readProcessIdentity(43, "win32"), undefined);
    }
    for (const status of [1, 3, null, undefined]) {
      value = { status, stdout: '{"CreationDate":"valid"}' };
      assert.equal(readProcessIdentity(43, "win32"), undefined);
    }
    // Scalar status-zero behavior intentionally does not adopt shared error/signal guards.
    value = { status: 0, error: new Error("synthetic"), signal: "SIGTERM", stdout: '{"CreationDate":"valid"}' };
    assert.equal(readProcessIdentity(43, "win32")?.start_time, "valid");
    throws = true;
    for (fault of [undefined, null, false, 0, "", {}]) {
      const before = calls;
      assert.throws(() => readProcessIdentity(43, "win32"), error => error === fault);
      assert.equal(calls, before + 1);
    }
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

const runner = "/agent/pi-actors/scripts/async-runner.mjs";
const stateDir = "/agent/tmp/pi-actors/runs/review";

function identity(runtimePlatform: NodeJS.Platform, startTime = "100"): RunProcessIdentity {
  return {
    command: `node ${runner} ${stateDir}`,
    ...(runtimePlatform === "linux" ? { cwd: "/work" } : {}),
    platform: runtimePlatform,
    start_time: startTime,
  };
}

for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
  test(`Run process identity rejects reused pids on ${runtimePlatform}`, () => {
    const expected = identity(runtimePlatform);
    const valid = verifyRunProcessIdentity(
      42,
      expected,
      runtimePlatform,
      () => expected,
      () => true,
    );
    assert.deepEqual(valid, { status: "valid", valid: true });
    const reused = verifyRunProcessIdentity(
      42,
      expected,
      runtimePlatform,
      () => identity(runtimePlatform, "200"),
      () => true,
    );
    assert.deepEqual(reused, { status: "owner_mismatch", valid: false });
  });
}

test("Run process identity distinguishes dead and unsupported proofs", () => {
  assert.deepEqual(
    verifyRunProcessIdentity(42, identity("linux"), "linux", () => undefined, () => false),
    { status: "dead_pid", valid: false },
  );
  assert.deepEqual(
    verifyRunProcessIdentity(42, undefined, "darwin", () => undefined, () => true),
    { status: "unsupported_proof", valid: false },
  );
});

test("Run process identity capture validates runner command and cwd", () => {
  const expected = identity("linux");
  assert.deepEqual(
    captureRunProcessIdentity(42, "/work", stateDir, runner, "linux", () => expected),
    expected,
  );
  assert.equal(
    captureRunProcessIdentity(42, "/other", stateDir, runner, "linux", () => expected),
    undefined,
  );
  assert.equal(
    captureRunProcessIdentity(42, "/work", "/wrong", runner, "linux", () => expected),
    undefined,
  );
});

test("Fresh-spawn capture waits for missing or empty argv without inventing a command", () => {
  for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
    for (const first of [undefined, { ...identity(runtimePlatform), command: "" }]) {
      let clock = 0;
      let reads = 0;
      const expected = identity(runtimePlatform);
      const result = captureSpawnedRunProcessIdentity(
        { pid: 42, exitCode: null, signalCode: null }, "/work", stateDir, runner, {
          runtimePlatform, now: () => clock, wait: (ms) => { clock += ms; },
          readIdentity: () => reads++ === 0 ? first : expected,
        },
      );
      assert.deepEqual(result, expected);
      assert.notEqual(result, expected);
      assert.equal(reads, 2);
      assert.ok(clock > 0);
    }
  }
});

test("Fresh-spawn capture never launders a known contradiction or changed birth into authority", () => {
  const expected = identity("linux");
  for (const first of [
    { ...expected, command: "node unrelated.js" },
    { ...expected, command: "", cwd: "/other" },
    { ...expected, platform: "darwin" as const },
    { ...expected, start_time: "" },
  ]) {
    let reads = 0;
    assert.equal(captureSpawnedRunProcessIdentity(
      { pid: 42, exitCode: null, signalCode: null }, "/work", stateDir, runner, {
        runtimePlatform: "linux", readIdentity: () => { reads++; return first; },
        wait: () => assert.fail("A known contradiction was retried"),
      },
    ), undefined);
    assert.equal(reads, 1);
  }
  let reads = 0;
  let clock = 0;
  assert.equal(captureSpawnedRunProcessIdentity(
    { pid: 42, exitCode: null, signalCode: null }, "/work", stateDir, runner, {
      runtimePlatform: "linux", now: () => clock, wait: (ms) => { clock += ms; },
      readIdentity: () => reads++ === 0 ? { ...expected, command: "" } : { ...expected, start_time: "200" },
    },
  ), undefined);
  assert.equal(reads, 2);
});

test("Fresh-spawn acquisition stays unproven within bounded time and attempt budgets", () => {
  for (const frozenClock of [false, true]) {
    let clock = 0;
    let reads = 0;
    const result = captureSpawnedRunProcessIdentity(
      { pid: 42, exitCode: null, signalCode: null }, "/work", stateDir, runner, {
        now: () => clock, wait: (ms) => { if (!frozenClock) clock += ms; },
        readIdentity: () => { reads++; return undefined; },
      },
    );
    assert.equal(result, undefined);
    assert.equal(reads, 101);
    assert.equal(clock, frozenClock ? 0 : 500);
  }
});

test("Invalid or already-exited fresh children never reach identity probes", () => {
  for (const child of [
    { pid: undefined, exitCode: null, signalCode: null },
    { pid: 0, exitCode: null, signalCode: null },
    { pid: -42, exitCode: null, signalCode: null },
    { pid: 1.5, exitCode: null, signalCode: null },
    { pid: 42, exitCode: 0, signalCode: null },
    { pid: 42, exitCode: null, signalCode: "SIGKILL" as const },
  ]) {
    assert.equal(captureSpawnedRunProcessIdentity(child, "/work", stateDir, runner, {
      readIdentity: () => assert.fail("An unowned/exited target was probed"),
      wait: () => assert.fail("An unowned/exited target was retried"),
    }), undefined);
  }
});

function probeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("Synthetic process probe failure"), { code });
}

test("Process liveness needs ESRCH for absence, not merely a failed probe", () => {
  assert.equal(readProcessLiveness(42, (pid, signal) => {
    assert.equal(pid, 42);
    assert.equal(signal, 0);
    return true;
  }), "alive");
  assert.equal(readProcessLiveness(42, () => false), "unknown");
  assert.equal(readProcessLiveness(42, () => { throw probeError("ESRCH"); }), "dead");
  for (const code of ["EPERM", "EACCES", "EIO", "EINTR", "ERR_INVALID_ARG_VALUE"]) {
    assert.equal(readProcessLiveness(42, () => { throw probeError(code); }), "unknown");
  }
  assert.equal(readProcessLiveness(42, () => { throw null; }), "unknown");
});

test("POSIX group presence requires a positive group id and ESRCH for absence", () => {
  for (const runtimePlatform of ["linux", "darwin"] as const) {
    assert.equal(readProcessGroupLiveness(42, runtimePlatform, (target, signal) => {
      assert.equal(target, -42);
      assert.equal(signal, 0);
      return true;
    }), "alive");
    assert.equal(readProcessGroupLiveness(42, runtimePlatform, () => { throw probeError("ESRCH"); }), "dead");
    for (const code of ["EPERM", "EACCES", "EINTR", "EIO"]) {
      assert.equal(readProcessGroupLiveness(42, runtimePlatform, () => { throw probeError(code); }), "unknown");
    }
    assert.equal(readProcessGroupLiveness(42, runtimePlatform, () => false), "unknown");
    assert.equal(readProcessGroupLiveness(42, runtimePlatform, () => { throw null; }), "unknown");
    for (const group of [0, -42, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(readProcessGroupLiveness(group, runtimePlatform, () => assert.fail("Unsafe group target was probed")), "unknown");
    }
  }
  for (const runtimePlatform of ["win32", "freebsd"] as const) {
    assert.equal(readProcessGroupLiveness(42, runtimePlatform, () => assert.fail("Unsupported group target was probed")), "unknown");
  }
});

test("Runner exit cannot substitute for remaining process-group evidence", () => {
  const expected = identity("linux");
  assert.deepEqual(observeRunProcessExit(42, expected, {
    runtimePlatform: "linux", probe: () => { throw probeError("ESRCH"); },
    readIdentity: () => assert.fail("Exited runner should not need identity lookup"),
  }), { status: "exited", process_identity_status: "dead_pid" });
  assert.equal(readProcessGroupLiveness(42, "linux", (target, signal) => {
    assert.equal(target, -42);
    assert.equal(signal, 0);
    return true;
  }), "alive");
});

test("A captured native detached group remains present until its fixture process exits", {
  skip: process.platform !== "linux" && process.platform !== "darwin",
  timeout: 15_000,
}, async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  await once(child, "spawn");
  const groupId = child.pid;
  assert.ok(groupId);
  assert.equal(readProcessGroupLiveness(groupId), "alive");
  const exited = once(child, "exit");
  assert.equal(child.kill("SIGKILL"), true);
  await exited;
  assert.equal(readProcessGroupLiveness(groupId), "dead");
});

test("Invalid process identities never probe pid zero, groups, or noninteger targets", () => {
  for (const pid of [0, -42, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readProcessLiveness(pid, () => assert.fail("Invalid pid was probed")), "unknown");
  }
  const expected = identity("linux");
  for (const malformed of [undefined, { ...expected, start_time: "" }, { ...expected, command: "" }]) {
    assert.deepEqual(observeRunProcessExit(42, malformed, {
      probe: () => assert.fail("Unproven identity was probed"),
      runtimePlatform: "linux",
    }), { status: "unproven", process_identity_status: "unsupported_proof" });
  }
});

test("Unknown liveness retains the active-state guard instead of authorizing restart", (t) => {
  t.mock.method(process, "kill", () => { throw probeError("EPERM"); });
  assert.equal(isAlive(2_000_000_000), true);
  assert.deepEqual(verifyRunProcessIdentity(
    2_000_000_000, identity(process.platform), process.platform, () => undefined,
  ), { status: "unsupported_proof", valid: false });
  assert.throws(() => readActiveOwnedRunState(
    stateDir,
    (path) => path.endsWith("run.json")
      ? { pid: 2_000_000_000, process_identity: identity(process.platform), run: "review" }
      : undefined,
    runner,
  ), /identity proof is unavailable/);
});

test("A successful signal acknowledgement is not process-exit evidence", () => {
  let signals = 0;
  const expected = identity("linux");
  const plan = signalOwnedRunProcess(42, "SIGKILL", expected, {
    killProcess: (pid, signal) => {
      signals++;
      assert.equal(pid, -42);
      assert.equal(signal, "SIGKILL");
      return true;
    },
    runtimePlatform: "linux",
    verifyIdentity: () => ({ valid: true, status: "valid" }),
  });
  assert.equal(plan.signalTarget, "processGroup");
  assert.equal(signals, 1);
  assert.deepEqual(observeRunProcessExit(42, expected, {
    probe: () => true,
    readIdentity: () => expected,
    runtimePlatform: "linux",
  }), { status: "running", process_identity_status: "valid" });
});

for (const runtimePlatform of ["linux", "darwin", "win32"] as const) {
  test(`Process-exit observation retains uncertainty and rejects foreign identity on ${runtimePlatform}`, () => {
    const expected = identity(runtimePlatform);
    const deps = { runtimePlatform, readIdentity: () => expected };
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => true,
    }), { status: "running", process_identity_status: "valid" });
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => { throw probeError("EPERM"); },
    }), { status: "unproven", process_identity_status: "unsupported_proof" });
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => true, readIdentity: () => undefined,
    }), { status: "unproven", process_identity_status: "unsupported_proof" });
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => true, readIdentity: () => identity(runtimePlatform, "200"),
    }), { status: "unproven", process_identity_status: "owner_mismatch" });
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => { throw probeError("ESRCH"); },
      readIdentity: () => assert.fail("A missing process has no readable identity"),
    }), { status: "exited", process_identity_status: "dead_pid" });
    assert.deepEqual(observeRunProcessExit(42, expected, {
      ...deps, probe: () => { throw probeError("ESRCH"); },
      runtimePlatform: runtimePlatform === "linux" ? "darwin" : "linux",
    }), { status: "unproven", process_identity_status: "unsupported_proof" });
  });
}

test("Native process-exit observation follows a captured fixture through verified exit", {
  skip: !["linux", "darwin", "win32"].includes(process.platform),
  timeout: 15_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-actors-process-exit-native-"));
  const child = spawn(process.execPath, ["-e", "process.send({pid:process.pid,ready:true}); setTimeout(() => {}, 10000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const frame: Record<string, unknown> = { pid: child.pid, parent_pid: process.pid, directory, host_exit: "not_asserted", child_exit: "not_asserted" };
  const persist = () => writeFileSync(join(directory, "frame.json"), JSON.stringify(frame));
  const closed = once(child, "close"); void closed.catch(() => {});
  const ready = once(child, "message"); void ready.catch(() => {});
  let primary: unknown; const cleanup: unknown[] = [];
  try {
    persist(); // Actual positive birth/handle before assertions or awaits; never backfill a plan as a PID.
    const pid = child.pid; assert.ok(Number.isSafeInteger(pid) && Number(pid) > 0);
    const [message] = await ready; frame.ready = message; persist();
    assert.deepEqual(message, { pid, ready: true });
    // spawn is not /proc command readiness; use the controlled child's actual after-import message.
    const expected = readProcessIdentity(pid!); frame.identity = expected; persist();
    assert.ok(expected?.command && expected.start_time);
    const running = observeRunProcessExit(pid!, expected); frame.running = running; persist();
    assert.deepEqual(running, { status: "running", process_identity_status: "valid" });
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await closed; frame.close = { code, signal }; persist();
    const exited = observeRunProcessExit(pid!, expected); frame.exited = exited; persist();
    assert.deepEqual(exited, { status: "exited", process_identity_status: "dead_pid" });
  } catch (error) { primary = error; }
  finally {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch (error) { cleanup.push(error); }
    try { const [code, signal] = await closed; frame.close = { code, signal }; } catch (error) { cleanup.push(error); }
    try {
      assert.ok(Number.isSafeInteger(child.pid) && Number(child.pid) > 0);
      assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }); frame.child_exit = "fresh_esrch";
    } catch (error) { cleanup.push(error); }
    try { persist(); } catch (error) { cleanup.push(error); }
  }
  // Retain the small evidence directory: this live test host cannot self-certify its own exit.
  if (primary || cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], `Native process-exit fixture failed; evidence retained: ${directory}`);
});
