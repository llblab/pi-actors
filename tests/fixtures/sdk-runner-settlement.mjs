import assert from "node:assert/strict";

const failureWitnesses = new WeakMap();
export const readSettlementFailureWitness = error => failureWitnesses.get(error);

// Test-only SDK fixture boundary: result acceptance never proves runner absence.
export async function settleCapturedRunner(run, persist, {
  now = () => performance.now(),
  probe = (pid, signal) => process.kill(pid, signal),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (run.settled) return;
  assert.ok(Number.isSafeInteger(run.pid) && run.pid > 0, "Captured fixture PID is unavailable");
  let probes = 0;
  const observeAbsence = () => {
    probes++;
    try { probe(run.pid, 0); }
    catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return true;
    }
    return false;
  };
  const acceptAbsence = async () => { run.settled = true; await persist(); };
  const started = now(), deadline = started + 5_000;
  let last = started, maximumGap = 0, clockValid = Number.isFinite(started) && Number.isFinite(deadline);
  const policyNow = () => {
    const value = now();
    if (!Number.isFinite(value) || value < last) clockValid = false;
    if (Number.isFinite(value) && Number.isFinite(last)) maximumGap = Math.max(maximumGap, value - last);
    last = value;
    return value;
  };
  while (policyNow() < deadline) {
    if (observeAbsence()) return acceptAbsence();
    await sleep(25);
  }
  // A delayed last sleep may cross the deadline; observe once, without another wait.
  if (observeAbsence()) return acceptAbsence();
  const error = new Error("Captured fixture runner exit remains unproven; retaining state");
  failureWitnesses.set(error, Object.freeze({ schema: "fixture-settlement-failure-v1",
    clock_scope: "caller monotonic policy samples only; not another process or native-call interval",
    clock_valid: clockValid, ...(clockValid ? { started_ms: started, deadline_ms: deadline,
      last_policy_observation_ms: last, largest_policy_gap_ms: maximumGap } : {}),
    probe_count: probes, last_probe: "present", original_runner_identity: "not_observed", exit: "unproven" }));
  throw error;
}
