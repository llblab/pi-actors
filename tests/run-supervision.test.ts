/** Mirrors lib/run-supervision.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  describe,
} from "node:test";
import {
  decodeRunSupervisionPolicy,
  resolveRunSupervisionPolicy,
  RUN_DIAGNOSTIC_MIN_INTERVAL_MS,
  sameRunSupervisionPolicy,
  createRunSupervisionClock,
  readRunSupervisionClock,
  captureRunSupervisionTimeOrigin,
  createRunSupervisionTimebase,
  RUN_SUPERVISION_TIMER_SLICE_MAX_MS,
  createRunSupervisionController,
  type RunSupervisionDeadlineObservation,
} from "../lib/run-supervision.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Policy", { concurrency: false }, async () => {


const FIELDS = ["report_every", "max_runtime"] as const;
const UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

test("supervision policy leaves both controls disabled without inventing defaults", () => {
  assert.deepEqual(resolveRunSupervisionPolicy(), {
    report_every_ms: null,
    max_runtime_ms: null,
    provenance: { report_every: "unset", max_runtime: "unset" },
  });
  assert.deepEqual(
    resolveRunSupervisionPolicy(undefined, undefined),
    resolveRunSupervisionPolicy(),
  );
});

test("routine diagnostic intervals have a one-minute floor without constraining execution deadlines", () => {
  assert.equal(RUN_DIAGNOSTIC_MIN_INTERVAL_MS, 60_000);
  for (const report_every of ["1ms", "59999ms", "1s", "59s"]) {
    assert.throws(() => resolveRunSupervisionPolicy({ report_every }), /recipe\.report_every.*at least 60000ms/);
    assert.throws(() => resolveRunSupervisionPolicy({}, { report_every }), /launch\.report_every.*at least 60000ms/);
    for (const override of [null, "1m"]) {
      assert.throws(() => resolveRunSupervisionPolicy({ report_every }, { report_every: override }), /at least 60000ms/);
    }
  }
  for (const report_every of ["60000ms", "60s", "1m"]) {
    assert.equal(resolveRunSupervisionPolicy({ report_every, max_runtime: "1ms" }).report_every_ms, 60_000);
  }
  assert.equal(resolveRunSupervisionPolicy({ report_every: "60001ms" }).report_every_ms, 60_001);
  assert.deepEqual(resolveRunSupervisionPolicy({ max_runtime: "1ms" }), {
    report_every_ms: null, max_runtime_ms: 1,
    provenance: { report_every: "unset", max_runtime: "recipe" },
  });
  assert.equal(resolveRunSupervisionPolicy({ report_every: null }).report_every_ms, null);
});

test("persisted diagnostic intervals retain the same one-minute floor without clamping", () => {
  for (const report_every_ms of [1, 999, 59_999]) {
    assert.throws(() => decodeRunSupervisionPolicy({ report_every_ms, max_runtime_ms: 1 }), /report_every_ms.*at least 60000ms/);
  }
  assert.deepEqual(decodeRunSupervisionPolicy({ report_every_ms: 60_000, max_runtime_ms: 1 }), {
    report_every_ms: 60_000, max_runtime_ms: 1,
  });
});

test("supervision policy normalizes every accepted duration unit independently", () => {
  for (const [unit, multiplier] of Object.entries(UNITS)) {
    for (const amount of [1, 2, 60, 60_000]) {
      const value = `${amount}${unit}`;
      const milliseconds = amount * multiplier;
      assert.equal(resolveRunSupervisionPolicy({ max_runtime: value }).max_runtime_ms, milliseconds);
      if (milliseconds >= RUN_DIAGNOSTIC_MIN_INTERVAL_MS) {
        assert.equal(resolveRunSupervisionPolicy({ report_every: value }).report_every_ms, milliseconds);
      } else {
        assert.throws(() => resolveRunSupervisionPolicy({ report_every: value }), /at least 60000ms/);
      }
    }
  }
  assert.deepEqual(resolveRunSupervisionPolicy({ report_every: "1h", max_runtime: "1ms" }), {
    report_every_ms: 3_600_000,
    max_runtime_ms: 1,
    provenance: { report_every: "recipe", max_runtime: "recipe" },
  }, "a report interval need not be shorter than the independent execution ceiling");
});

test("supervision policy rejects nonliteral durations and non-null disable aliases", () => {
  const invalid: unknown[] = [
    false, true, 0, 1, -1, NaN, Infinity, 1n, [], {}, new String("1s"),
    "", "0", "0ms", "01s", "-1s", "+1s", "1.5s", "1e3ms", "1_000ms",
    "1", "ms", "1S", "1M", "1d", "1m30s", "1 s", "off", "null",
    "{duration}", "{max_runtime=1m}",
  ];
  for (const field of FIELDS) {
    for (const value of invalid) {
      assert.throws(
        () => resolveRunSupervisionPolicy({ [field]: value }),
        new RegExp(`recipe\\.${field}.*positive integer duration`),
      );
      assert.throws(
        () => resolveRunSupervisionPolicy({}, { [field]: value }),
        new RegExp(`launch\\.${field}.*positive integer duration`),
      );
    }
  }
});

test("supervision literal matching rejects whitespace including final line terminators", () => {
  for (const value of [
    " 1s", "1s ", "\t1s", "1s\t", "1s\n", "1s\r", "1s\r\n",
    "1s\u2028", "1s\u2029", "\u00a01s", "1\u00a0s",
  ]) {
    for (const field of FIELDS) {
      assert.throws(() => resolveRunSupervisionPolicy({ [field]: value }));
    }
  }
});

test("supervision duration arithmetic admits the safe boundary and rejects overflow", () => {
  for (const [unit, multiplier] of Object.entries(UNITS)) {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / multiplier);
    for (const field of FIELDS) {
      const valid = resolveRunSupervisionPolicy({ [field]: `${maximum}${unit}` });
      assert.equal(
        field === "report_every" ? valid.report_every_ms : valid.max_runtime_ms,
        maximum * multiplier,
      );
      assert.throws(
        () => resolveRunSupervisionPolicy({ [field]: `${maximum + 1}${unit}` }),
        /safe integer millisecond range/,
      );
      assert.throws(
        () => resolveRunSupervisionPolicy({}, { [field]: `${"9".repeat(500)}${unit}` }),
        /safe integer millisecond range/,
      );
    }
  }
});

test("supervision precedence is field-local across the complete omission/null/value matrix", () => {
  const choices = [undefined, null, "2m"] as const;
  const expected = (recipe: typeof choices[number], launch: typeof choices[number]) => {
    const value = launch !== undefined ? launch : recipe;
    return {
      value: value === undefined || value === null ? null : 120_000,
      source: launch !== undefined ? "launch" : recipe !== undefined ? "recipe" : "unset",
    };
  };
  for (const recipeReport of choices) for (const recipeMaximum of choices) {
    for (const launchReport of choices) for (const launchMaximum of choices) {
      const recipe = { report_every: recipeReport, max_runtime: recipeMaximum };
      const launch = { report_every: launchReport, max_runtime: launchMaximum };
      const report = expected(recipeReport, launchReport);
      const maximum = expected(recipeMaximum, launchMaximum);
      assert.deepEqual(resolveRunSupervisionPolicy(recipe, launch), {
        report_every_ms: report.value,
        max_runtime_ms: maximum.value,
        provenance: { report_every: report.source, max_runtime: maximum.source },
      });
    }
  }
});

test("supervision launch overrides do not bypass invalid authored Recipe policies", () => {
  for (const field of FIELDS) {
    for (const override of [null, "1m"]) {
      assert.throws(
        () => resolveRunSupervisionPolicy({ [field]: "invalid" }, { [field]: override }),
        new RegExp(`recipe\\.${field}`),
      );
    }
  }
});

test("supervision reads only own policy fields, never actor arguments or inherited settings", () => {
  const recipe = Object.create({ report_every: "1s", max_runtime: "1s" });
  Object.defineProperty(recipe, "values", {
    get() { throw new Error("unrelated actor values must not be read"); },
  });
  const launch = Object.create({ report_every: "3s", max_runtime: "3s" });
  Object.defineProperty(launch, "defaults", {
    get() { throw new Error("unrelated actor defaults must not be read"); },
  });
  assert.deepEqual(resolveRunSupervisionPolicy(recipe, launch), resolveRunSupervisionPolicy());
  assert.deepEqual(
    resolveRunSupervisionPolicy({ values: { report_every: "1s", max_runtime: "2s" } }),
    resolveRunSupervisionPolicy(),
  );
  Object.defineProperty(recipe, "report_every", { value: "2m", enumerable: true });
  assert.equal(resolveRunSupervisionPolicy(recipe, launch).report_every_ms, 120_000);
});

test("supervision rejects malformed layer containers before treating them as empty policies", () => {
  for (const invalid of [null, [], "1m", 1, true, () => {}]) {
    assert.throws(() => resolveRunSupervisionPolicy(invalid), /recipe policy must be an object/);
    assert.throws(() => resolveRunSupervisionPolicy({}, invalid), /launch policy must be an object/);
  }
});

test("supervision resolution is pure and returns fresh provenance records", () => {
  const recipe = Object.freeze({ report_every: "2m", max_runtime: "1h" });
  const launch = Object.freeze({ max_runtime: null });
  const first = resolveRunSupervisionPolicy(recipe, launch);
  const second = resolveRunSupervisionPolicy(recipe, launch);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.provenance, second.provenance);
  assert.deepEqual(recipe, { report_every: "2m", max_runtime: "1h" });
  assert.deepEqual(launch, { max_runtime: null });
});

test("supervision semantic comparison ignores duration spelling, provenance, and clocks", () => {
  const recipe = resolveRunSupervisionPolicy({ report_every: "60s", max_runtime: "1h" });
  const launch = resolveRunSupervisionPolicy({}, { report_every: "1m", max_runtime: "60m" });
  assert.notDeepEqual(recipe.provenance, launch.provenance);
  assert.equal(sameRunSupervisionPolicy(recipe, launch), true);
  assert.equal(sameRunSupervisionPolicy(
    resolveRunSupervisionPolicy(),
    resolveRunSupervisionPolicy({ report_every: null, max_runtime: null }),
  ), true);
  const withClock = { ...recipe, deadline_at: "an earlier generation's clock" };
  assert.equal(sameRunSupervisionPolicy(withClock, launch), true);
  assert.equal(sameRunSupervisionPolicy(recipe, { ...launch, report_every_ms: 60_001 }), false);
  assert.equal(sameRunSupervisionPolicy(recipe, { ...launch, max_runtime_ms: null }), false);
});

test("supervision invalid-value diagnostics are bounded and do not echo arbitrary payloads", () => {
  const messages: string[] = [];
  for (const value of ["bad", "private-token-" + "x".repeat(16_384)]) {
    assert.throws(
      () => resolveRunSupervisionPolicy({}, { max_runtime: value }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /launch\.max_runtime/);
        assert.doesNotMatch(error.message, /private-token/);
        messages.push(error.message);
        return true;
      },
    );
  }
  assert.equal(messages[0], messages[1], "diagnostic size/content must not depend on the rejected payload");
});

});

await describe("Persisted clocks", { concurrency: false }, async () => {


const START = Date.parse("2026-01-01T00:00:00.000Z");
const DATE_LIMIT = 8_640_000_000_000_000;

test("persisted supervision policies require exact positive milliseconds or explicit null", () => {
  for (const [report, maximum] of [[null, null], [60_000, 2], [Number.MAX_SAFE_INTEGER, null]] as const) {
    assert.deepEqual(
      decodeRunSupervisionPolicy({ report_every_ms: report, max_runtime_ms: maximum }),
      { report_every_ms: report, max_runtime_ms: maximum },
    );
  }
  for (const field of ["report_every_ms", "max_runtime_ms"] as const) {
    for (const invalid of [undefined, "1000", "1s", false, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => decodeRunSupervisionPolicy({
        report_every_ms: null,
        max_runtime_ms: null,
        [field]: invalid,
      }), new RegExp(field));
    }
  }
  assert.throws(() => decodeRunSupervisionPolicy({}), /stored supervision/);
  assert.throws(() => decodeRunSupervisionPolicy(null), /must be an object/);
  assert.throws(() => decodeRunSupervisionPolicy([]), /must be an object/);
  assert.throws(() => decodeRunSupervisionPolicy(Object.create({
    report_every_ms: null, max_runtime_ms: null,
  })), /stored supervision/);
});

test("generation clock captures the supplied start once without implicit policy defaults", () => {
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy(), START);
  assert.deepEqual(clock, {
    started_at: "2026-01-01T00:00:00.000Z",
    supervision: { report_every_ms: null, max_runtime_ms: null, deadline_at: null },
  });
  const later = createRunSupervisionClock(resolveRunSupervisionPolicy(), START + 1000);
  assert.notEqual(later.started_at, clock.started_at);
  assert.notEqual(later.supervision, clock.supervision);
});

test("generation deadline is derived from the captured start, not a later attachment time", () => {
  const policy = resolveRunSupervisionPolicy({ report_every: "2m", max_runtime: "20m" });
  const clock = createRunSupervisionClock(policy, START);
  assert.equal(clock.supervision.deadline_at, "2026-01-01T00:20:00.000Z");
  const serialized = JSON.stringify({ ...clock, run_instance_id: "generation-a" });
  for (let attachment = 0; attachment < 3; attachment++) {
    assert.deepEqual(readRunSupervisionClock(JSON.parse(serialized)), clock);
    assert.equal(serialized, JSON.stringify({ ...clock, run_instance_id: "generation-a" }));
  }
});

test("generation clock checks native timestamp bounds and absolute-deadline overflow", () => {
  const disabled = resolveRunSupervisionPolicy();
  const oneMillisecond = resolveRunSupervisionPolicy({ max_runtime: "1ms" });
  assert.equal(
    createRunSupervisionClock(oneMillisecond, DATE_LIMIT - 1).supervision.deadline_at,
    new Date(DATE_LIMIT).toISOString(),
  );
  assert.equal(createRunSupervisionClock(disabled, DATE_LIMIT).started_at, new Date(DATE_LIMIT).toISOString());
  for (const start of [DATE_LIMIT + 1, NaN, Infinity, Number.MAX_SAFE_INTEGER, START + 0.5]) {
    assert.throws(() => createRunSupervisionClock(disabled, start), /started_at/);
  }
  assert.throws(() => createRunSupervisionClock(oneMillisecond, DATE_LIMIT), /deadline_at/);
  assert.throws(
    () => createRunSupervisionClock(resolveRunSupervisionPolicy({ max_runtime: `${Number.MAX_SAFE_INTEGER}ms` }), START),
    /deadline_at/,
  );
});

test("stored clocks remain unchanged when decoded and retain explicit disabled ceilings", () => {
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy({ report_every: "1h" }), START);
  const stored = Object.freeze({ ...clock, supervision: Object.freeze(clock.supervision) });
  const decoded = readRunSupervisionClock(stored)!;
  assert.deepEqual(decoded, stored);
  assert.notEqual(decoded, stored);
  assert.notEqual(decoded.supervision, stored.supervision);
  assert.equal(decoded.supervision.deadline_at, null);
});

test("legacy absence is not silently converted to a new clock or fresh budget", () => {
  assert.equal(readRunSupervisionClock({ createdAt: "2025-01-01T00:00:00.000Z" }), undefined);
  assert.equal(readRunSupervisionClock(Object.create({
    started_at: "2026-01-01T00:00:00.000Z",
    supervision: { report_every_ms: null, max_runtime_ms: null, deadline_at: null },
  })), undefined);
  for (const partial of [
    { started_at: "2026-01-01T00:00:00.000Z" },
    { supervision: { report_every_ms: null, max_runtime_ms: null, deadline_at: null } },
    { supervision_provenance: { report_every: "unset", max_runtime: "unset" } },
  ]) assert.throws(() => readRunSupervisionClock(partial), /incomplete/);
  assert.throws(
    () => readRunSupervisionClock({ started_at: undefined, supervision: undefined }),
    /started_at/,
  );
});

test("stored clocks reject coercion, noncanonical dates, and contradictory deadlines", () => {
  const clock = createRunSupervisionClock(resolveRunSupervisionPolicy({ max_runtime: "1m" }), START);
  assert.throws(() => readRunSupervisionClock({
    ...clock, supervision: { ...clock.supervision, report_every_ms: 59_999 },
  }), /at least 60000ms/);
  assert.throws(() => readRunSupervisionClock({
    ...clock, createdAt: new Date(START + 1).toISOString(),
  }), /contradicts generation creation time/);
  for (const started_at of [
    START, "", "2026-01-01", "2026-01-01T03:00:00.000+03:00",
    "2026-02-30T00:00:00.000Z", "not-a-date",
  ]) assert.throws(() => readRunSupervisionClock({ ...clock, started_at }), /started_at/);
  for (const deadline_at of [
    null, undefined, START + 60_000, "2026-01-01T00:02:00.000Z",
  ]) assert.throws(() => readRunSupervisionClock({
    ...clock, supervision: { ...clock.supervision, deadline_at },
  }), /deadline_at/);
  const { deadline_at: _deadline, ...withoutDeadline } = clock.supervision;
  assert.throws(() => readRunSupervisionClock({ ...clock, supervision: withoutDeadline }), /deadline_at/);
  assert.throws(() => readRunSupervisionClock({
    started_at: clock.started_at,
    supervision: { report_every_ms: null, max_runtime_ms: null, deadline_at: clock.supervision.deadline_at },
  }), /deadline_at/);
});

});

await describe("Live time origins", { concurrency: false }, async () => {
/** Runtime-local generation origins and monotonic observation; not native supervision or deadline actuation. */

const START = Date.parse("2026-01-01T00:00:00.000Z");
function fixture(maximum: number | null = 1000, report: number | null = null) {
  let wall = START; let mono = 100.25; let epoch: object = {}; let fail = false; let monoReads = 0; let wallReads = 0;
  const source = { wallNow: () => { wallReads++; return wall; }, monotonicNow: () => { monoReads++; if (fail) throw Error("PRIVATE clock unavailable"); return { milliseconds: mono, epoch }; } };
  const origin = captureRunSupervisionTimeOrigin(source);
  const stored = createRunSupervisionClock({ report_every_ms: report, max_runtime_ms: maximum }, origin.wall_ms);
  const created = createRunSupervisionTimebase(stored, origin); assert.equal(created.state, "available"); if (created.state !== "available") throw Error("Fixture timebase unavailable");
  return { origin, stored, timebase: created.timebase, setWall: (value: number) => { wall = value; }, setMono: (value: number) => { mono = value; },
    changeEpoch: () => { epoch = {}; }, fail: () => { fail = true; }, reads: () => ({ mono: monoReads, wall: wallReads }) };
}

test("Live elapsed includes time since generation origin and ignores subsequent wall jumps without resetting allowance", () => {
  const f = fixture(); assert.deepEqual(f.timebase.observe(), { state: "available", elapsed_ms: 0, remaining_ms: 1000, deadline_state: "pending", deadline_wake_ms: 1000 });
  f.setMono(350.25); f.setWall(START + 5_000_000); const before = f.timebase.observe();
  assert.deepEqual(before, { state: "available", elapsed_ms: 250, remaining_ms: 750, deadline_state: "pending", deadline_wake_ms: 750 });
  f.setWall(START - 5_000_000); assert.deepEqual(f.timebase.observe(), before); assert.equal(f.reads().wall, 1);
  f.setMono(1100.25); assert.deepEqual(f.timebase.observe(), { state: "available", elapsed_ms: 1000, remaining_ms: 0, deadline_state: "due", deadline_wake_ms: 0 });
  f.setMono(5100.25); const overdue = f.timebase.observe(); assert.equal(overdue.state, "available"); assert.equal(overdue.deadline_state, "due");
  assert.equal(f.timebase.clock.supervision.deadline_at, f.stored.supervision.deadline_at);
});

test("Fractional monotonic samples never fire early; elapsed floors and remaining/wake delays ceil to host milliseconds", () => {
  const f = fixture(1); f.setMono(100.75);
  assert.deepEqual(f.timebase.observe(), { state: "available", elapsed_ms: 0, remaining_ms: 1, deadline_state: "pending", deadline_wake_ms: 1 });
  f.setMono(101.249); assert.equal(f.timebase.observe().deadline_state, "pending"); f.setMono(101.25); assert.equal(f.timebase.observe().deadline_state, "due");
});

test("Extreme safe-integer allowances retain exact remaining time under fractional monotonic samples", () => {
  let mono = 0; const epoch = {};
  const origin = captureRunSupervisionTimeOrigin({ wallNow: () => -8_000_000_000_000_000, monotonicNow: () => ({ milliseconds: mono, epoch }) });
  const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: Number.MAX_SAFE_INTEGER }, origin.wall_ms);
  const reading = createRunSupervisionTimebase(clock, origin); if (reading.state !== "available") throw Error("Extreme timebase unavailable");
  mono = 0.5; const observed = reading.timebase.observe(); assert.equal(observed.elapsed_ms, 0); assert.equal(observed.remaining_ms, Number.MAX_SAFE_INTEGER);
  assert.equal(observed.deadline_wake_ms, RUN_SUPERVISION_TIMER_SLICE_MAX_MS);
});

test("Disabled policies still provide mandatory elapsed without diagnostic wakes or synthesized defaults", () => {
  const f = fixture(null); f.setMono(71_100.25);
  assert.deepEqual(f.timebase.observe(), { state: "available", elapsed_ms: 71000, remaining_ms: null, deadline_state: "disabled", deadline_wake_ms: null });
  const reportsOnly = fixture(null, 60001); reportsOnly.setMono(60101.25);
  assert.equal(reportsOnly.timebase.observe().deadline_wake_ms, null); assert.equal(reportsOnly.timebase.clock.supervision.report_every_ms, 60001);
});

test("Long deadline wake plans use bounded slices from the original origin, never timer clamping or missed-tick replay", () => {
  const maximum = RUN_SUPERVISION_TIMER_SLICE_MAX_MS * 3 + 71; const f = fixture(maximum);
  const start = f.timebase.observe(); assert.equal(start.remaining_ms, maximum); assert.equal(start.deadline_wake_ms, RUN_SUPERVISION_TIMER_SLICE_MAX_MS);
  f.setMono(100.25 + RUN_SUPERVISION_TIMER_SLICE_MAX_MS + 50); const later = f.timebase.observe();
  assert.equal(later.remaining_ms, maximum - RUN_SUPERVISION_TIMER_SLICE_MAX_MS - 50); assert.equal(later.deadline_wake_ms, RUN_SUPERVISION_TIMER_SLICE_MAX_MS);
  f.setMono(100.25 + maximum - 9.5); assert.equal(f.timebase.observe().deadline_wake_ms, 10);
  f.setMono(100.25 + maximum + 1); assert.equal(f.timebase.observe().deadline_wake_ms, 0);
});

test("Late handles with a genuine retained origin keep elapsed and frozen policy; copied/serialized origins cannot reconstruct continuity", () => {
  const f = fixture(); f.setMono(800.25); const before = f.timebase.observe(); const saved = JSON.stringify(f.stored);
  const attached = createRunSupervisionTimebase(JSON.parse(saved), f.origin); assert.equal(attached.state, "available");
  if (attached.state === "available") { assert.deepEqual(attached.timebase.observe(), before); assert.equal(Object.isFrozen(attached.timebase.clock.supervision), true); }
  for (const origin of [{ ...f.origin }, JSON.parse(JSON.stringify(f.origin)), null, undefined, {}]) {
    assert.deepEqual(createRunSupervisionTimebase(f.stored, origin), { state: "unavailable", reason: "origin_unavailable" });
  }
  assert.equal(saved, JSON.stringify(f.stored)); assert.equal(Object.isFrozen(f.origin), true);
  const originalMaximum = f.timebase.clock.supervision.max_runtime_ms;
  assert.deepEqual(createRunSupervisionTimebase(createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START), f.origin), { state: "unavailable", reason: "clock_changed" });
  assert.equal(f.timebase.clock.supervision.max_runtime_ms, originalMaximum);
});

test("Missing/invalid clocks and mismatched origins never acquire a current start, new policy or fresh allowance", () => {
  const f = fixture(); const reads = f.reads();
  assert.deepEqual(createRunSupervisionTimebase({}, f.origin), { state: "unavailable", reason: "clock_unconfigured" });
  assert.deepEqual(createRunSupervisionTimebase({ ...f.stored, supervision: { ...f.stored.supervision, deadline_at: null } }, f.origin), { state: "unavailable", reason: "clock_invalid" });
  assert.deepEqual(createRunSupervisionTimebase(createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 1000 }, START + 1), f.origin), { state: "unavailable", reason: "origin_mismatch" });
  assert.deepEqual(f.reads(), reads); assert.equal(f.timebase.observe().elapsed_ms, 0);
});

test("Backward, nonfinite, unsafe or different-epoch samples latch uncertainty across all handles without renewed reads", () => {
  for (const invalid of [-1, 100, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "epoch"] as const) {
    const f = fixture(); f.setMono(300.25); assert.equal(f.timebase.observe().elapsed_ms, 200);
    if (invalid === "epoch") f.changeEpoch(); else f.setMono(invalid);
    const uncertain = f.timebase.observe(); assert.equal(uncertain.state, "unproven"); assert.equal(uncertain.elapsed_ms, null); assert.equal(uncertain.remaining_ms, null);
    assert.equal(uncertain.deadline_state, "unproven"); assert.equal(uncertain.deadline_wake_ms, null); assert.equal(Object.isFrozen(uncertain), true);
    const reads = f.reads(); f.setMono(900.25); assert.deepEqual(f.timebase.observe(), uncertain);
    const attached = createRunSupervisionTimebase(f.stored, f.origin); if (attached.state === "available") assert.deepEqual(attached.timebase.observe(), uncertain);
    else assert.fail("Retained origin metadata attachment should not silently replace continuity");
    assert.deepEqual(f.reads(), reads);
  }
});

test("A previously proven due fact survives clock uncertainty; disabled deadlines stay disabled, never pending by fallback", () => {
  const f = fixture(1); f.setMono(102.25); assert.equal(f.timebase.observe().deadline_state, "due"); f.fail();
  const reading = f.timebase.observe(); assert.equal(reading.state, "unproven"); assert.equal(reading.deadline_state, "due"); assert.equal(reading.deadline_wake_ms, 0);
  assert.doesNotMatch(JSON.stringify(reading), /PRIVATE/);
  const off = fixture(null); off.fail(); assert.equal(off.timebase.observe().deadline_state, "disabled");
});

test("Origin capture rejects invalid wall/monotonic evidence and failed sources without publishing a usable origin", () => {
  for (const wall of [NaN, Infinity, 0.5, 8_640_000_000_000_001]) {
    assert.throws(() => captureRunSupervisionTimeOrigin({ wallNow: () => wall, monotonicNow: () => ({ milliseconds: 0, epoch: {} }) }));
  }
  for (const milliseconds of [-1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => captureRunSupervisionTimeOrigin({ wallNow: () => START, monotonicNow: () => ({ milliseconds, epoch: {} }) }));
  }
  const failure = Error("original clock failure"); assert.throws(() => captureRunSupervisionTimeOrigin({ wallNow: () => { throw failure; }, monotonicNow: () => ({ milliseconds: 0, epoch: {} }) }), error => error === failure);
});

test("Time source sample fields are snapshotted once before validation and arithmetic", () => {
  const epoch = {}; let calls = 0; let reads = 0;
  const origin = captureRunSupervisionTimeOrigin({ wallNow: () => START, monotonicNow: () => {
    const current = calls++; let fieldReads = 0;
    return { epoch, get milliseconds() { reads++; return ++fieldReads === 1 ? current * 5 : NaN; } };
  } });
  const created = createRunSupervisionTimebase(createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 10 }, START), origin);
  assert.equal(created.state, "available"); if (created.state !== "available") return;
  assert.deepEqual(created.timebase.observe(), { state: "available", elapsed_ms: 5, remaining_ms: 5, deadline_state: "pending", deadline_wake_ms: 5 });
  assert.equal(reads, 2);
});

test("Default clock source works without timers, work/model callbacks or later wall-clock reads", () => {
  const origin = captureRunSupervisionTimeOrigin(); const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: null }, origin.wall_ms);
  const created = createRunSupervisionTimebase(clock, origin); assert.equal(created.state, "available");
  const wall = Date.now; const timer = globalThis.setTimeout;
  Date.now = () => assert.fail("Live monotonic observation read wall clock"); globalThis.setTimeout = (() => assert.fail("Timebase scheduled a timer")) as unknown as typeof setTimeout;
  try { if (created.state === "available") assert.equal(created.timebase.observe().state, "available"); }
  finally { Date.now = wall; globalThis.setTimeout = timer; }
});

});

await describe("Controller boundaries", { concurrency: false }, async () => {
/** Deadline wake protocol and host-timer wiring; no native scope, actuation or independent-process proof. */
const START = Date.parse("2026-01-01T00:00:00.000Z");
function fixture(maximum: number | null = 1000, report: number | null = null) {
  const identity = { run: "controlled", run_instance_id: "generation-a", ownerId: "owner-a" };
  let mono = 0; const epoch = {}; const origin = captureRunSupervisionTimeOrigin({ wallNow: () => START, monotonicNow: () => ({ milliseconds: mono, epoch }) });
  const clock = createRunSupervisionClock({ report_every_ms: report, max_runtime_ms: maximum }, START);
  const reading = createRunSupervisionTimebase(clock, origin); if (reading.state !== "available") throw Error("Fixture timebase unavailable");
  let current: { identity: unknown; clock: unknown } | null = { identity, clock }; let reads = 0; let cancelFail = false;
  const timers: { wake: () => void; delay: number; cancelled: boolean; cancels: number }[] = []; const events: Readonly<RunSupervisionDeadlineObservation>[] = [];
  const ports = { readCurrent: () => { reads++; return current; }, schedule: (wake: () => void, delay: number) => {
    const timer = { wake, delay, cancelled: false, cancels: 0 }; timers.push(timer); return () => { timer.cancelled = true; timer.cancels++; if (cancelFail) throw Error("PRIVATE cancel failure"); };
  }, onDeadlineDue: (event: Readonly<RunSupervisionDeadlineObservation>) => { events.push(event); } };
  const controller = createRunSupervisionController(identity, reading.timebase, ports);
  return { identity, clock, timebase: reading.timebase, ports, controller, timers, events, setMono: (value: number) => { mono = value; },
    setCurrent: (value: { identity: unknown; clock: unknown } | null) => { current = value; }, failCancel: () => { cancelFail = true; }, reads: () => reads };
}

test("Malformed or inherited identities cannot create a controller or reach state/timer ports", () => {
  const f = fixture();
  for (const expected of [null, {}, { ...f.identity, run: "controlled\n" }, { ...f.identity, run_instance_id: "" },
    { ...f.identity, ownerId: "" }, Object.create(f.identity)]) assert.throws(() => createRunSupervisionController(expected, f.timebase, f.ports));
  assert.equal(f.reads(), 0); assert.equal(f.timers.length, 0);
});

test("One deadline timer rechecks exact binding/clock and notifies once at due, never a terminal/stop claim", () => {
  const f = fixture(); assert.equal(f.reads(), 0); assert.equal(f.controller.snapshot().state, "idle");
  assert.equal(f.controller.start().state, "armed"); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 1000);
  const reads = f.reads(); assert.equal(f.controller.start().state, "armed"); assert.equal(f.reads(), reads); assert.equal(f.timers.length, 1);
  f.setMono(1000); f.timers[0].wake(); assert.equal(f.events.length, 1); assert.equal(f.controller.snapshot().state, "due");
  assert.deepEqual(f.events[0].identity, f.identity); assert.equal(f.events[0].deadline_at, f.clock.supervision.deadline_at);
  assert.equal(f.events[0].kind, "run_deadline_due"); assert.equal(f.events[0].scope_closure, "not_asserted"); assert.equal(f.events[0].stop_requested, false);
  assert.equal(Object.isFrozen(f.events[0]), true); assert.equal(Object.isFrozen(f.events[0].identity), true);
  f.timers[0].wake(); f.controller.start(); assert.equal(f.events.length, 1); assert.equal(f.timers.length, 1);
});

test("Early wakes and long durations recompute from original origin without overflow, fixed-tick replay or renewed allowance", () => {
  const maximum = RUN_SUPERVISION_TIMER_SLICE_MAX_MS + 100; const f = fixture(maximum); f.controller.start();
  assert.equal(f.timers[0].delay, RUN_SUPERVISION_TIMER_SLICE_MAX_MS);
  f.setMono(40); f.timers[0].wake(); assert.equal(f.timers[1].delay, RUN_SUPERVISION_TIMER_SLICE_MAX_MS);
  f.timers[0].wake(); assert.equal(f.timers.length, 2);
  f.setMono(maximum - 3.5); f.timers[1].wake(); assert.equal(f.timers[2].delay, 4);
  f.setMono(maximum + 5000); f.timers[2].wake(); assert.equal(f.events.length, 1); assert.equal(f.timers.length, 3);
});

test("Disabled deadlines create no timers, identity reads or notifications, including reporting-only policy", () => {
  for (const report of [null, 60001]) {
    const f = fixture(null, report); assert.equal(f.controller.start().state, "disabled"); assert.equal(f.timers.length, 0); assert.equal(f.reads(), 0); assert.equal(f.events.length, 0);
  }
});

test("Changed generation, owner or clock fences pending callbacks without latest-generation substitution", () => {
  for (const current of [
    { identity: { run: "controlled", run_instance_id: "generation-b", ownerId: "owner-a" } },
    { identity: { run: "controlled", run_instance_id: "generation-a", ownerId: "owner-b" } },
    { identity: { run: "other", run_instance_id: "generation-a", ownerId: "owner-a" } },
  ]) {
    const f = fixture(); f.controller.start(); f.setCurrent({ ...current, clock: f.clock }); f.setMono(1000); f.timers[0].wake();
    assert.equal(f.controller.snapshot().state, "unproven"); assert.equal(f.events.length, 0); assert.equal(f.timers.length, 1);
    f.setCurrent({ identity: f.identity, clock: f.clock }); f.controller.start(); f.timers[0].wake(); assert.equal(f.events.length, 0);
  }
  const f = fixture(); f.controller.start(); f.setCurrent({ identity: f.identity, clock: createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 2000 }, START) });
  f.setMono(1000); f.timers[0].wake(); assert.equal(f.controller.snapshot().reason, "clock_changed"); assert.equal(f.events.length, 0);
});

test("Binding replacement during monotonic observation is rechecked before arming or notifying", () => {
  const f = fixture(); let swap = false;
  const timebase = { clock: f.timebase.clock, observe: () => { const value = f.timebase.observe(); if (swap) f.setCurrent({ identity: { ...f.identity, run_instance_id: "generation-b" }, clock: f.clock }); return value; } };
  const controller = createRunSupervisionController(f.identity, timebase, f.ports); controller.start(); swap = true; f.setMono(1000); f.timers[0].wake();
  assert.equal(controller.snapshot().state, "unproven"); assert.equal(f.events.length, 0); assert.equal(f.timers.length, 1);
});

test("Clock uncertainty stops wakes without inventing budget; already proven due stays due on the emitted fact", () => {
  const f = fixture(); f.controller.start(); f.setMono(-1); f.timers[0].wake(); assert.equal(f.controller.snapshot().reason, "clock_unproven"); assert.equal(f.events.length, 0);
  const due = fixture(1); due.setMono(1); assert.equal(due.timebase.observe().deadline_state, "due"); due.setMono(-1); due.controller.start();
  assert.equal(due.events.length, 1); assert.equal(due.events[0].timing.state, "unproven"); assert.equal(due.controller.snapshot().deadline_due, true);
});

test("Stop revokes callbacks before cancellation; cleanup failure remains explicit, not proof of removed host timer", () => {
  const f = fixture(); f.controller.start(); f.failCancel(); const stopped = f.controller.stop();
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.timer_cleanup, "unproven"); assert.equal(f.timers[0].cancels, 1);
  f.setMono(1000); f.timers[0].wake(); f.controller.start(); f.controller.stop(); assert.equal(f.events.length, 0); assert.equal(f.timers[0].cancels, 1);
});

test("Provider exceptions and invalid/inline scheduling fail closed without recursive loops or implicit retry", () => {
  for (const schedule of [() => { throw Error("PRIVATE scheduling failure"); }, (wake: () => void) => { wake(); return () => {}; }, () => undefined]) {
    const f = fixture(); const controller = createRunSupervisionController(f.identity, f.timebase, { ...f.ports, schedule: schedule as typeof f.ports.schedule });
    assert.equal(controller.start().state, "unproven"); assert.equal(f.events.length, 0); controller.start(); assert.doesNotMatch(JSON.stringify(controller.snapshot()), /PRIVATE/);
  }
  const lost = fixture(); const invalid = createRunSupervisionController(lost.identity, lost.timebase, { ...lost.ports,
    schedule: ((wake: () => void) => { wake(); return undefined; }) as unknown as typeof lost.ports.schedule });
  assert.equal(invalid.start().timer_cleanup, "unproven");
  const f = fixture(); const controller = createRunSupervisionController(f.identity, f.timebase, { ...f.ports, readCurrent: () => { throw Error("PRIVATE identity failure"); } });
  assert.equal(controller.start().reason, "binding_unavailable"); assert.equal(f.events.length, 0);
});

test("Due observer failure is retained without a second emission; snapshot reads never poll clock or identity", () => {
  const f = fixture(1); let attempts = 0; const controller = createRunSupervisionController(f.identity, f.timebase, { ...f.ports, onDeadlineDue: () => { attempts++; throw Error("PRIVATE observer failure"); } });
  f.setMono(1); assert.equal(controller.start().reason, "notification_failed"); assert.equal(controller.snapshot().deadline_due, true);
  const reads = f.reads(); controller.snapshot(); controller.start(); assert.equal(attempts, 1); assert.equal(f.reads(), reads);
});

test("Reentrant stop from identity/observation/notification ports cannot rearm or resurrect a controller", () => {
  const f = fixture(); let controller: ReturnType<typeof createRunSupervisionController>;
  controller = createRunSupervisionController(f.identity, f.timebase, { ...f.ports, readCurrent: () => { controller.stop(); return { identity: f.identity, clock: f.clock }; } });
  assert.equal(controller.start().state, "stopped"); assert.equal(f.timers.length, 0);
  const during = fixture(); let observing: ReturnType<typeof createRunSupervisionController>;
  observing = createRunSupervisionController(during.identity, { clock: during.clock, observe: () => { observing.stop(); return during.timebase.observe(); } }, during.ports);
  assert.equal(observing.start().state, "stopped"); assert.equal(during.timers.length, 0);
  const due = fixture(1); due.setMono(1); let notified: ReturnType<typeof createRunSupervisionController>;
  notified = createRunSupervisionController(due.identity, due.timebase, { ...due.ports, onDeadlineDue: () => { notified.stop(); } });
  assert.equal(notified.start().state, "stopped"); assert.equal(notified.snapshot().deadline_due, true); assert.equal(due.timers.length, 0);
});

test("Node timer integration delivers a bound due fact with no workload/model driver, without claiming independent-process enforcement", { timeout: 3000 }, async t => {
  const origin = captureRunSupervisionTimeOrigin(); const clock = createRunSupervisionClock({ report_every_ms: null, max_runtime_ms: 15 }, origin.wall_ms);
  const reading = createRunSupervisionTimebase(clock, origin); if (reading.state !== "available") throw Error("Default timebase unavailable");
  const identity = { run: "timer-smoke", run_instance_id: "generation-a" }; let resolve!: (value: Readonly<RunSupervisionDeadlineObservation>) => void;
  const done = new Promise<Readonly<RunSupervisionDeadlineObservation>>(accept => { resolve = accept; });
  const controller = createRunSupervisionController(identity, reading.timebase, { readCurrent: () => ({ identity, clock }), onDeadlineDue: event => { resolve(event); } });
  t.after(() => controller.stop()); controller.start(); const event = await done;
  assert.equal(event.identity.run_instance_id, identity.run_instance_id); assert.equal(event.timing.deadline_state, "due"); assert.equal(controller.snapshot().state, "due");
});

});
