/** Fixture-only original runner birth, close and acceptance join. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import type { TestContext } from "node:test";
import { readProcessLiveness } from "../../lib/runs-process.ts";

export type FixtureBirth = {
  pid: number | undefined;
  close?: { code: number | null; signal: NodeJS.Signals | null };
  closed: Promise<void>;
};

export function observeFixtureBirth(child: {
  pid?: number;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}): FixtureBirth {
  let settle!: () => void;
  const birth: FixtureBirth = { pid: child.pid, closed: new Promise<void>((resolve) => { settle = resolve; }) };
  child.once("close", (code, signal) => { birth.close = { code, signal }; settle(); });
  return birth;
}

export function captureFixtureBirths(t: TestContext) {
  const births: FixtureBirth[] = [], spawn = childProcess.spawn;
  const hook = t.mock.method(childProcess, "spawn", (...args: any[]) => {
    const child: childProcess.ChildProcess = Reflect.apply(spawn, childProcess, args);
    if (args[0] === process.execPath && Array.isArray(args[1]) &&
        args[1].some((arg: unknown) => typeof arg === "string" && basename(arg) === "async-runner.mjs")) {
      births.push(observeFixtureBirth(child));
    }
    return child;
  });
  syncBuiltinESMExports();
  return { births, restore() { try { hook.mock.restore(); } finally { syncBuiltinESMExports(); } } };
}

export function bindFixtureBirth(births: FixtureBirth[], pid: unknown): FixtureBirth {
  assert.ok(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0, "Missing original runner PID; retaining roots");
  const matches = births.filter((birth) => birth.pid === pid);
  assert.equal(matches.length, 1, "Receipt must bind exactly one captured original birth; retaining roots");
  return matches[0];
}

type JoinPorts = {
  read: (path: string) => Promise<string>;
  liveness: (pid: number) => string;
  watchdog: (expire: () => void, ms: number) => () => void;
};
const nativePorts: JoinPorts = {
  read: (path) => readFile(path, "utf8"),
  liveness: readProcessLiveness,
  watchdog(expire, ms) { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); },
};

export function requireFreshFixtureAbsence(birth: FixtureBirth, liveness = nativePorts.liveness): void {
  assert.ok(birth.pid !== undefined && Number.isSafeInteger(birth.pid) && birth.pid > 0, "Unproven birth; retaining roots");
  assert.equal(liveness(birth.pid), "dead", "Fresh ESRCH-only runner absence unproven; retaining roots");
}

export function throwFixtureErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Fixture failed; roots may be retained", { cause: errors[0] });
}

// One deliberately amended 10s acceptance-phase budget, not a native birth or product deadline.
export async function joinFixtureRunners(entries: { birth: FixtureBirth; path: string }[], ports: JoinPorts = nativePorts): Promise<void> {
  let expire!: () => void, expired = false;
  const context = JSON.stringify(entries.map(({ birth, path }) => ({ path, pid: birth.pid ?? null })));
  const timeoutError = new Error(`Fixture acceptance watchdog expired after 10000ms; retaining roots; entries_at_join=${context}`);
  const timeout = new Promise<never>((_resolve, reject) => {
    expire = () => { expired = true; reject(timeoutError); };
  });
  const cancel = ports.watchdog(expire, 10_000);
  const errors: unknown[] = [];
  try {
    const joined = await Promise.allSettled(entries.map(({ birth, path }) => Promise.race([
      (async () => {
        await birth.closed;
        if (expired) throw timeoutError;
        assert.deepEqual(birth.close, { code: 0, signal: null });
        const result = JSON.parse(await ports.read(path));
        if (expired) throw timeoutError;
        assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
        assert.equal(result.code, 0);
        requireFreshFixtureAbsence(birth, ports.liveness);
      })(),
      timeout,
    ])));
    for (const result of joined) if (result.status === "rejected") errors.push(result.reason);
  } catch (error) { errors.push(error); }
  finally { try { cancel(); } catch (error) { errors.push(error); } }
  throwFixtureErrors(errors);
}
