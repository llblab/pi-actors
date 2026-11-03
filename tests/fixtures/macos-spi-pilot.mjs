#!/usr/bin/env node
// Opt-in research fixture A, NOT a public tool, backend, scope grant or C1 proof.
// Importing this module performs no IO, subprocess creation or native probe.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ABI = "f6217f891ac0bb64f3d375211650a4c1ff8ca1ea";
const PROFILE_SCHEMA = "pi-actors-spi-a-profile-v2";
const roles = ["D", "A", "B", "A.leaf", "B.leaf"];
const parents = { A: "D", B: "D", "A.leaf": "A", "B.leaf": "B" };
const integer = (v, min = 0, max = 0x7fffffff) => Number.isSafeInteger(v) && v >= min && v <= max;
const pid = v => integer(v, 1);
const u64 = v => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const array = (v, check, count) => Array.isArray(v) && (count === undefined || v.length === count) && v.every(check);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keys(value, names) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype || !same(Object.keys(value).sort(), names.split(" ").sort()) || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))) throw Error("Unexpected pilot record shape");
}
function requireFact(ok, reason) { if (!ok) throw Error(reason); }

export function parsePilotAFrame(line) {
  requireFact(typeof line === "string" && Buffer.byteLength(line) <= 4095 && !line.includes("\n"), "Invalid pilot frame boundary");
  const r = JSON.parse(line);
  requireFact(r && typeof r === "object" && !Array.isArray(r), "Invalid pilot record");
  requireFact(pid(r.pid), "Invalid positive pilot PID");
  if (r.event === "hello") {
    keys(r, "event pid abi unique_size coalition_size coalition_types watchdog_ms");
    requireFact(r.abi === ABI && r.unique_size === 56 && r.coalition_size === 40 && r.coalition_types === 2 && r.watchdog_ms === 30000, "Unreviewed pilot ABI declaration");
  } else if (r.event === "birth" || r.event === "wait") {
    keys(r, r.event === "birth" ? "event parent_role role parent_pid pid" : "event parent_role role parent_pid pid kind value raw_status");
    requireFact(Object.hasOwn(parents, r.role) && parents[r.role] === r.parent_role && pid(r.parent_pid) && r.pid !== r.parent_pid, "Invalid parent/child capture");
    if (r.event === "wait") {
      requireFact(integer(r.raw_status, 0, 65535) && integer(r.value, 0, 255), "Invalid raw wait status");
      const low = r.raw_status & 127;
      requireFact(r.kind === "exit" ? low === 0 && r.value === ((r.raw_status >> 8) & 255) : r.kind === "signal" ? low > 0 && low < 127 && r.value === low : r.kind === "other" && low === 127 && r.value === 0, "Wait status interpretation mismatch");
    }
  } else if (r.event === "observe") {
    keys(r, "event role phase pid ppid pgid sid uid euid gid egid groups unique_return unique_errno coalition_return coalition_errno uuid uniqueid parent_uniqueid idversion original_parent_version unique_reserved coalition_ids coalition_reserved setsid_attempted setsid_result setsid_errno");
    requireFact(roles.includes(r.role) && (r.role.endsWith(".leaf") ? ["before", "after"].includes(r.phase) : r.phase === "ready"), "Unexpected observation role/phase");
    requireFact([r.ppid, r.pgid, r.sid].every(pid), "Invalid observed relationship");
    requireFact([r.uid, r.euid, r.gid, r.egid].every(v => integer(v, 0, 0xffffffff)) && array(r.groups, v => integer(v, 0, 0xffffffff)) && r.groups.length <= 128, "Invalid native credential vector");
    requireFact([r.unique_return, r.coalition_return].every(v => integer(v, -1)) && [r.unique_errno, r.coalition_errno, r.setsid_errno].every(v => integer(v)), "Invalid SPI result/errno");
    requireFact(typeof r.uuid === "string" && /^[a-f0-9]{32}$/.test(r.uuid) && u64(r.uniqueid) && u64(r.parent_uniqueid) && array(r.unique_reserved, u64, 2) && array(r.coalition_ids, u64, 2) && array(r.coalition_reserved, u64, 3), "Lossy or invalid native identity");
    requireFact([r.idversion, r.original_parent_version].every(v => integer(v, -2147483648)), "Invalid native version");
    requireFact(typeof r.setsid_attempted === "boolean" && (r.setsid_attempted ? integer(r.setsid_result, -1) : r.setsid_result === null) && (r.setsid_attempted || r.setsid_errno === 0), "Invalid setsid receipt");
  } else if (r.event === "fault") {
    keys(r, "event role pid stage error");
    requireFact(roles.includes(r.role) && ["gate", "pipe", "fork", "waitpid", "transport", "deadline", "setsid", "rights"].includes(r.stage) && integer(r.error), "Invalid native fault");
  } else if (r.event === "end") {
    keys(r, "event pid io_ok complete");
    requireFact(typeof r.io_ok === "boolean" && typeof r.complete === "boolean", "Invalid driver end");
  } else throw Error("Unknown pilot event");
  return r;
}

// Independent stderr diagnostics are data only, never a completion/scope grant.
export function parsePilotATransportFault(line) {
  requireFact(typeof line === "string" && Buffer.byteLength(line) < 512 && !line.includes("\n"), "Invalid transport diagnostic boundary");
  const r = JSON.parse(line);
  keys(r, "event role pid stage error written requested first_stage first_error first_written first_requested");
  const stages = ["format", "clock", "lock", "write", "unlock", "stderr_flags", "stdout_flags", "lock_fd"];
  requireFact(r.event === "transport_fault" && roles.includes(r.role) && pid(r.pid) && stages.includes(r.stage) && stages.includes(r.first_stage), "Invalid transport diagnostic identity/stage");
  requireFact([r.error, r.first_error, r.written, r.requested, r.first_written, r.first_requested].every(v => integer(v)) && r.written <= r.requested && r.first_written <= r.first_requested, "Invalid transport errno/progress");
  if (r.stage === r.first_stage) requireFact(r.error === r.first_error && r.written === r.first_written && r.requested === r.first_requested, "First transport cause changed");
  return r;
}

// Pure producer shared with CLI; measured facts supply no schema or authority.
export function buildPilotAProfile(measured) {
  requireFact(!Object.hasOwn(measured, "schema"), "Measured profile facts must not supply schema");
  return { schema: PROFILE_SCHEMA, ...measured };
}

const EVIDENCE_SCHEMA = "pi-actors-spi-a-evidence-v1";
const captureFiles = name => ["birth.json", "exit.json", "close.json", "stdout", "stderr"].map(suffix => `${name}.${suffix}`);
export function buildPilotAEvidenceInventory(commands, complete = false) {
  requireFact(Array.isArray(commands) && commands.length <= 32 && typeof complete === "boolean" && (!complete || commands.length > 0), "Invalid preflight inventory boundary");
  const preflights = commands.map((spec, index) => {
    keys(spec, "command args stdio");
    requireFact(typeof spec.command === "string" && spec.command.length > 0 && spec.command.length <= 4096 && array(spec.args, v => typeof v === "string" && v.length <= 4096) && spec.args.length <= 128, "Invalid preflight declaration");
    if (spec.stdio !== null) {
      keys(spec.stdio, "stdout stderr");
      for (const stream of [spec.stdio.stdout, spec.stdio.stderr]) {
        keys(stream, "bytes sha256");
        requireFact(integer(stream.bytes, 0, 1048576) && typeof stream.sha256 === "string" && /^[a-f0-9]{64}$/.test(stream.sha256), "Invalid preflight raw capture digest");
      }
    }
    requireFact(!complete || spec.stdio !== null, "Unsettled preflight inventory");
    return { name: `preflight-${index + 1}`, command: spec.command, args: [...spec.args], stdio: spec.stdio === null ? null : { stdout: { ...spec.stdio.stdout }, stderr: { ...spec.stdio.stderr } } };
  });
  return { schema: EVIDENCE_SCHEMA, complete, preflights, files: [
    "evidence-inventory.json", "requested-profile.json", "actual-profile.json", "binary.json", "pilot-a", "frames.json", "absence.json", "report.json",
    ...captureFiles("driver"), ...preflights.flatMap(p => captureFiles(p.name)),
  ] };
}
export function readPilotAEvidenceInventory(value) {
  keys(value, "schema complete preflights files");
  requireFact(value.schema === EVIDENCE_SCHEMA && Array.isArray(value.preflights), "Invalid evidence inventory schema");
  const commands = value.preflights.map(p => { keys(p, "name command args stdio"); return { command: p.command, args: p.args, stdio: p.stdio }; });
  const canonical = buildPilotAEvidenceInventory(commands, value.complete);
  requireFact(same(value, canonical), "Noncanonical evidence inventory");
  return canonical;
}
// The writer must settle before launch. A failed declaration latches this
// producer closed; no later command or finish can repair it into a positive run.
export function createPilotAEvidenceInventory(write) {
  let commands = [], closed = false;
  const emit = value => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    try { write(bytes); } catch (error) { closed = true; throw error; }
    return sha(bytes);
  };
  emit(buildPilotAEvidenceInventory(commands));
  return {
    declare(command, args) {
      requireFact(!closed, "Evidence inventory producer is closed");
      requireFact(commands.length === 0 || commands.at(-1).stdio !== null, "Previous preflight is unsettled");
      const next = buildPilotAEvidenceInventory([...commands, { command, args, stdio: null }]);
      emit(next); commands = next.preflights.map(p => ({ command: p.command, args: p.args, stdio: p.stdio }));
      return next.preflights.at(-1).name;
    },
    record(name, stdout, stderr) {
      requireFact(!closed && commands.length > 0 && name === `preflight-${commands.length}` && commands.at(-1).stdio === null && Buffer.isBuffer(stdout) && Buffer.isBuffer(stderr), "Invalid preflight settlement");
      const describe = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
      const next = commands.map(p => ({ ...p }));
      next.at(-1).stdio = { stdout: describe(stdout), stderr: describe(stderr) };
      emit(buildPilotAEvidenceInventory(next)); commands = next;
    },
    finish() {
      requireFact(!closed, "Evidence inventory producer is closed");
      const final = buildPilotAEvidenceInventory(commands, true);
      closed = true; return emit(final);
    },
  };
}

// Caller-owned explicit profile, not an authority token. Only the FIRST proposed
// profile is implemented; later matrix rows require first-witness review.
export function admitPilotAProfile(expected, actual) {
  try {
    const fields = "schema profile platform arch node_major os_version os_build darwin_release image_version xcode_version xcode_build sdk_version sdk_build compiler_version developer_dir github_repository commit fixture_sha256 transport_sha256 harness_sha256";
    keys(expected, fields); keys(actual, fields);
    for (const key of fields.split(" ")) requireFact(typeof expected[key] === "string" && expected[key].length > 0 && expected[key].length <= 4096 && expected[key] === actual[key], `Profile mismatch: ${key}`);
    requireFact(expected.schema === PROFILE_SCHEMA && expected.profile === "macos-15-arm64" && expected.platform === "darwin" && expected.arch === "arm64" && expected.node_major === "24", "First native profile only");
    requireFact(/^15\.[0-9]+(?:\.[0-9]+)?$/.test(expected.os_version) && /^24\./.test(expected.darwin_release), "Unexpected OS family");
    requireFact(expected.xcode_version === "16.4" && expected.xcode_build === "16F6" && expected.sdk_version === "15.5" && expected.developer_dir === "/Applications/Xcode_16.4.app/Contents/Developer", "Unreviewed toolchain");
    requireFact(/^[a-f0-9]{40}$/.test(expected.commit) && [expected.fixture_sha256, expected.transport_sha256, expected.harness_sha256].every(v => /^[a-f0-9]{64}$/.test(v)), "Invalid source binding");
    return { admitted: true };
  } catch (error) { return { admitted: false, status: "ENVIRONMENT_BLOCKED", reason: error.message }; }
}

// Prefix validation is the release-gate boundary, not just a final-report check.
export function nextPilotACommand(frames, driver, stage) {
  try {
    requireFact(pid(driver.pid) && pid(driver.parent_pid) && integer(stage, 0, 4), "Invalid outer capture/stage");
    const captured = new Map([["D", driver.pid]]), seen = new Map();
    let hello = false;
    for (const r of frames) {
      if (r.event === "hello") { requireFact(!hello && r.pid === driver.pid && frames[0] === r, "Wrong driver hello"); hello = true; }
      else if (r.event === "birth") {
        requireFact(hello && seen.has(`${r.parent_role}:ready`) && captured.get(r.parent_role) === r.parent_pid && !captured.has(r.role) && ![...captured.values(), driver.parent_pid].includes(r.pid), "Unproven/conflicting native birth");
        captured.set(r.role, r.pid);
      } else if (r.event === "observe") {
        requireFact(hello && captured.get(r.role) === r.pid && !seen.has(`${r.role}:${r.phase}`), "Uncaptured/duplicate native readiness");
        requireFact(r.unique_return === 56 && r.coalition_return === 40 && r.uniqueid !== "0" && [...r.unique_reserved, ...r.coalition_reserved].every(v => v === "0"), "ABI/readiness refused");
        const baseline = seen.get("D:ready");
        if (r.phase !== "after") requireFact([...seen.values()].every(o => o.uniqueid !== r.uniqueid), "Duplicate native birth identity");
        if (r.role === "D") requireFact(r.ppid === driver.parent_pid && r.uid > 0 && r.euid > 0 && (!driver.credentials || ["uid", "euid", "gid", "egid"].every(k => r[k] === driver.credentials[k])), "Driver birth/credentials changed");
        else {
          const parent = seen.get(`${parents[r.role]}:ready`);
          requireFact(parent && r.ppid === parent.pid && r.parent_uniqueid === parent.uniqueid && r.original_parent_version === parent.idversion && ["uid", "euid", "gid", "egid", "groups", "uuid"].every(k => same(r[k], baseline[k])), "Parent/credentials unavailable or changed");
        }
        if (r.phase === "after") {
          const before = seen.get(`${r.role}:before`);
          requireFact(before && ["uniqueid", "idversion", "parent_uniqueid", "original_parent_version"].every(k => same(r[k], before[k])), "Post-observation identity changed");
        }
        seen.set(`${r.role}:${r.phase}`, r);
      } else if (r.event === "fault") throw Error("Native fault: hold/abort gates");
    }
    const has = (role, phase) => seen.has(`${role}:${phase}`);
    const command = stage === 0 && has("D", "ready") ? "S" : stage === 1 && has("A", "ready") && has("B", "ready") ? "E" : stage === 2 && has("A.leaf", "before") && has("B.leaf", "before") ? "O" : stage === 3 && has("A.leaf", "after") && has("B.leaf", "after") ? "R" : null;
    return { command, stage: command ? stage + 1 : stage, refused: null };
  } catch (error) { return { command: null, stage, refused: error.message }; }
}

// Pure consistency projection: synthetic unit records do not establish native
// evidence. Only the CLI below supplies actual capture/close/absence observations.
export function evaluatePilotA({ frames, driver, close, absent, rawComplete, timedOut = false, faults = [] }) {
  const result = (status, reason, extra = {}) => ({ status, reason, exclusive_run_scope_proven: false, phase_b_admitted: false, c1_accepted: false, ...extra });
  try {
    requireFact(pid(driver.pid) && pid(driver.parent_pid), "Missing actual outer-parent driver capture");
    requireFact(rawComplete && !timedOut && faults.length === 0 && close && close.signal === null && [0, 2].includes(close.code), "Incomplete host/transport evidence");
    const hello = frames.filter(r => r.event === "hello");
    const end = frames.filter(r => r.event === "end");
    requireFact(hello.length === 1 && end.length === 1 && hello[0].pid === driver.pid && end[0].pid === driver.pid && end[0].io_ok, "Missing/duplicate driver boundaries");
    const births = frames.filter(r => r.event === "birth"), waits = frames.filter(r => r.event === "wait"), obs = frames.filter(r => r.event === "observe");
    const captured = new Map([["D", driver.pid]]);
    for (const b of births) {
      requireFact(!captured.has(b.role) && captured.get(b.parent_role) === b.parent_pid && ![...captured.values(), driver.parent_pid].includes(b.pid), "Conflicting or uncaptured birth");
      captured.set(b.role, b.pid);
    }
    requireFact([...captured.values()].every(p => absent.includes(p)), "Fresh ESRCH is missing for a captured process");
    for (const w of waits) requireFact(captured.get(w.role) === w.pid && captured.get(w.parent_role) === w.parent_pid, "Uncaptured wait");
    for (const role of captured.keys()) if (role !== "D") requireFact(waits.filter(w => w.role === role).length === 1, "Missing/duplicate actual parent wait");
    requireFact(obs.every(o => captured.get(o.role) === o.pid), "Uncaptured observation");
    // Known unavailable ABI is NO_GO only after every known birth has settled.
    if (obs.some(o => o.unique_return !== 56 || o.coalition_return !== 40 || [...o.unique_reserved, ...o.coalition_reserved].some(v => v !== "0"))) return result("NO_GO_PROFILE", "SPI unavailable, denied or outside reviewed ABI");
    requireFact(captured.size === 5 && births.length === 4 && waits.length === 4 && obs.length === 7 && frames.length === 17 && end[0].complete && close.code === 0, "Incomplete fixed-topology journey");
    requireFact(nextPilotACommand(frames, driver, 4).refused === null, "Prefix admission failed");
    requireFact(obs.every(o => o.setsid_attempted === (o.role === "A.leaf" && o.phase === "after")), "Unexpected session mutation");
    requireFact(waits.every(w => w.kind === "exit" && w.value === 0), "Non-natural/failed child settlement");
    const get = (role, phase) => {
      const matches = obs.filter(o => o.role === role && o.phase === phase);
      requireFact(matches.length === 1, "Missing/duplicate observation phase"); return matches[0];
    };
    const baseline = get("D", "ready");
    requireFact(baseline.ppid === driver.parent_pid && baseline.uid > 0 && baseline.euid > 0, "Wrong original parent/rights");
    const baselineFields = ["uid", "euid", "gid", "egid", "groups", "uuid"];
    const uniqueIds = new Set();
    for (const [role, p] of captured) {
      const before = get(role, role.endsWith(".leaf") ? "before" : "ready");
      requireFact(before.uniqueid !== "0" && !uniqueIds.has(before.uniqueid) && before.pid === p && baselineFields.every(k => same(before[k], baseline[k])), "Birth identity/credential drift");
      uniqueIds.add(before.uniqueid);
      if (role !== "D") {
        const parent = get(parents[role], "ready"), b = births.find(b => b.role === role), w = waits.find(w => w.role === role);
        requireFact(before.ppid === parent.pid && before.parent_uniqueid === parent.uniqueid && before.original_parent_version === parent.idversion, "Native parent identity mismatch");
        requireFact(frames.indexOf(parent) < frames.indexOf(b) && frames.indexOf(b) < frames.indexOf(before) && frames.indexOf(before) < frames.indexOf(w), "Birth/readiness/wait ordering mismatch");
      }
    }
    for (const role of ["A.leaf", "B.leaf"]) {
      const before = get(role, "before"), after = get(role, "after"), w = waits.find(w => w.role === role);
      requireFact(["pid", "ppid", "uniqueid", "parent_uniqueid", "idversion", "original_parent_version", ...baselineFields].every(k => same(before[k], after[k])) && frames.indexOf(before) < frames.indexOf(after) && frames.indexOf(after) < frames.indexOf(w), "Post-observation identity drift/order");
      if (role === "A.leaf" && !(after.setsid_attempted && after.setsid_result === after.pid && after.setsid_errno === 0 && after.sid === after.pid && after.pgid === after.pid)) return result("NO_GO_PROFILE", "setsid observation case unavailable");
      requireFact(!before.setsid_attempted && (role !== "B.leaf" || (!after.setsid_attempted && after.sid === before.sid && after.pgid === before.pgid)), "Control branch changed session");
      requireFact(frames.indexOf(w) < frames.indexOf(waits.find(w => w.role === parents[role])), "Parent settled before leaf receipt");
    }
    requireFact(frames[0] === hello[0] && frames.at(-1) === end[0], "Unexpected transcript boundaries");
    return result("PASS_A", "Observational cases and fixture settlements only", {
      shared_resource_coalition: get("A", "ready").coalition_ids[0] === get("B", "ready").coalition_ids[0],
      setsid_resource_stable: get("A.leaf", "before").coalition_ids[0] === get("A.leaf", "after").coalition_ids[0],
    });
  } catch (error) { return result("INCONCLUSIVE", error.message); }
}

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function persist(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
function describe(error, seen = new Set()) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return { type: typeof error, value: typeof error === "string" ? error : undefined };
  if (seen.has(error)) return { type: "repeated-cause" };
  seen.add(error);
  const data = {};
  for (const key of ["code", "message"]) {
    const d = Object.getOwnPropertyDescriptor(error, key);
    if (d && Object.hasOwn(d, "value") && typeof d.value === "string") data[key] = d.value;
  }
  const causes = Object.getOwnPropertyDescriptor(error, "errors");
  if (error instanceof AggregateError && causes && Object.hasOwn(causes, "value") && Array.isArray(causes.value)) data.causes = causes.value.map(e => describe(e, seen));
  return data;
}
function throwCaptureCauses(causes) {
  if (causes.length === 1) throw causes[0];
  throw new AggregateError(causes, "Pilot capture and resource release failed");
}
// Explicit IO prevents unit calls from silently falling back to native effects.
// Ownership includes release of the optional caller-held parent descriptor.
export function capturePilotA(io, command, args, options, root, name, onFrame, release) {
  let out, err, child, parent;
  try {
    out = io.openSync(join(root, `${name}.stdout`), "wx", 0o600);
    err = io.openSync(join(root, `${name}.stderr`), "wx", 0o600);
    parent = io.parentFrame();
    child = io.spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe", ...(options.lockFd === undefined ? [] : [options.lockFd])] });
  } catch (error) {
    const causes = [error];
    for (const fd of [err, out]) if (fd !== undefined) try { io.closeSync(fd); } catch (cleanup) { causes.push(cleanup); }
    if (release) try { release(); } catch (cleanup) { causes.push(cleanup); }
    throwCaptureCauses(causes);
  }
  const attempt = { ...parent, command, args };
  const birth = pid(child.pid) ? { pid: child.pid, ...attempt } : null; // before any await; never reconstruct a missing birth
  const causes = [], faults = [];
  let stdin, stdout, stderr;
  let rawComplete = false, timedOut = false, buffered = Buffer.alloc(0), bytes = 0, protocolActive = !!birth;
  let gatesClosed = !birth, inputEnded = false, parentReleased = false, attemptRecorded = false;
  const record = error => {
    causes.push(error);
    try { faults.push(describe(error)); }
    catch (summaryError) { causes.push(summaryError); faults.push({ type: "fault-summary-unavailable" }); }
  };
  const abort = () => {
    gatesClosed = true;
    if (inputEnded) return;
    inputEnded = true;
    if (stdin) try { stdin.end(); } catch (error) { record(error); }
  };
  const fail = error => { gatesClosed = true; record(error); abort(); };
  const send = command => {
    if (gatesClosed) return false;
    try { stdin.write(command); return true; } // backpressure is not a failed request
    catch (error) { fail(error); return false; }
  };
  const releaseParent = () => {
    if (!release || parentReleased) return;
    parentReleased = true;
    try { release(); } catch (error) { fail(error); }
  };
  const saveAttempt = () => {
    if (birth || attemptRecorded) return;
    attemptRecorded = true;
    try { io.persist(join(root, `${name}.attempt.json`), { attempt, faults }); } catch (error) { fail(error); }
  };
  const control = { attempt, birth, abort, fail, send };
  const settled = new Promise(resolve => {
    // EMFILE/ENFILE can return a ChildProcess with no PID or stdio, then emit
    // error asynchronously. Own that error before inspecting optional streams.
    child.on("error", error => { fail(error); saveAttempt(); });
    child.once("exit", (code, signal) => {
      if (!birth) return; // an unbound handle event is not a process exit receipt
      try { io.persist(join(root, `${name}.exit.json`), { code, signal }); } catch (error) { fail(error); }
    });
    stdin = child.stdin; stdout = child.stdout; stderr = child.stderr;
    rawComplete = !!(birth && stdin && stdout && stderr);
    if (!rawComplete) gatesClosed = true;
    stdin?.on("error", fail);
    const data = (fd, buffer, protocol) => {
      bytes += buffer.length;
      if (bytes > 1048576) { rawComplete = false; fail(Error("Raw capture budget exceeded; retained prefix is incomplete")); return; }
      try { let at = 0; while (at < buffer.length) { const n = io.writeSync(fd, buffer, at); requireFact(n > 0, "Incomplete raw write"); at += n; } }
      catch (error) { rawComplete = false; fail(error); }
      if (!protocol || !protocolActive) return;
      buffered = Buffer.concat([buffered, buffer]);
      try {
        for (let newline; (newline = buffered.indexOf(10)) >= 0;) {
          requireFact(newline <= 4095, "Oversized native frame");
          const line = new TextDecoder("utf-8", { fatal: true }).decode(buffered.subarray(0, newline));
          buffered = buffered.subarray(newline + 1);
          onFrame(parsePilotAFrame(line), control);
        }
        requireFact(buffered.length < 4096, "Unterminated/oversized native frame");
      } catch (error) { protocolActive = false; fail(error); }
    };
    const readError = error => { rawComplete = false; fail(error); };
    stdout?.on("error", readError);
    stderr?.on("error", readError);
    stdout?.on("data", b => data(out, b, !!onFrame));
    stderr?.on("data", b => data(err, b, false));
    child.once("close", (code, signal) => {
      gatesClosed = true;
      try { io.clearTimeout(timer); } catch (error) { fail(error); }
      if (protocolActive && buffered.length) fail(Error("Partial final native frame"));
      saveAttempt();
      for (const fd of [err, out]) try { io.closeSync(fd); } catch (error) { rawComplete = false; fail(error); }
      // Defer an unbound attempt's release until its provider error/handle close;
      // cleanup errors must not precede or replace the asynchronous spawn error.
      releaseParent();
      const receipt = { attempt, birth, close: birth ? { code, signal } : null, ...(!birth ? { handle_close: { code, signal } } : {}), rawComplete, timedOut, faults };
      try { io.persist(join(root, `${name}.${birth ? "close" : "attempt-close"}.json`), receipt); } catch (error) { fail(error); receipt.rawComplete = false; }
      resolve({ ...receipt, causes }); // exact private originals; JSON uses ordered summaries
    });
    // Deadline is observation, not synthetic termination. Keep actual close pending.
    let timer;
    try {
      timer = io.setTimeout(() => {
        timedOut = true;
        fail(Error("180s observation deadline; native settlement remains unproven"));
        try { io.persist(join(root, `${name}.deadline.json`), { status: "INCONCLUSIVE", attempt, birth, faults }); } catch (error) { record(error); }
      }, 180000);
    } catch (error) { fail(error); }
  });
  if (birth) {
    try { io.persist(join(root, `${name}.birth.json`), birth); } catch (error) { fail(error); }
    // After a captured birth, release failure still cannot skip actual close.
    releaseParent();
  }
  if (!onFrame) abort();
  return { ...control, settled };
}
const nativeCaptureIO = {
  spawn, openSync, closeSync, writeSync, persist, setTimeout, clearTimeout,
  parentFrame: () => ({ parent_pid: process.pid, credentials: { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid() } }),
};
// A required probe port keeps unit import/calls non-native. After real parent
// waits/driver close, ANY presence/denial is inconsistent or possible PID reuse;
// do not retry it into a later green receipt or erase the original cause.
export function observePilotAAbsence(pids, probe) {
  requireFact(Array.isArray(pids) && pids.length > 0 && pids.length <= 5 && pids.every(pid) && new Set(pids).size === pids.length && typeof probe === "function", "Invalid absence-probe admission");
  return pids.map(p => {
    try { probe(p); return { pid: p, state: "present" }; }
    catch (error) {
      const cause = describe(error);
      return { pid: p, state: cause.code === "ESRCH" ? "absent" : "unknown", cause };
    }
  });
}

async function executeCLI() {
  const args = process.argv.slice(2);
  const blocked = reason => ({ status: "ENVIRONMENT_BLOCKED", reason, c1_accepted: false, phase_b_admitted: false });
  if (args.length !== 3 || args[0] !== "--execute-readonly-pilot-a") return blocked("Explicit execution flag, reviewed profile JSON path and DEVELOPER_DIR required");
  if (process.platform !== "darwin" || process.env.CI !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.getuid() === 0 || process.geteuid() === 0) return blocked("Native ordinary-user manual CI execution only");
  if (args[2] !== "/Applications/Xcode_16.4.app/Contents/Developer") return blocked("First toolchain only");
  const expectedBytes = readFileSync(args[1]);
  requireFact(expectedBytes.length <= 65536, "Oversized profile");
  const expected = JSON.parse(expectedBytes.toString("utf8"));
  const base = "/tmp/pi-actors-validation";
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "mac-a-"));
  const report = { evidence_mode: "native-research-only", status: "INCONCLUSIVE", reason: "Execution not yet complete", retained_root: root, c1_accepted: false, phase_b_admitted: false };
  const save = () => persist(join(root, "report.json"), report);
  save(); persist(join(root, "requested-profile.json"), expected);
  const developer = args[2];
  for (const dir of ["home", "tmp", "clang-cache"]) mkdirSync(join(root, dir), { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", DEVELOPER_DIR: developer, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), CLANG_MODULE_CACHE_PATH: join(root, "clang-cache") };
  const inventory = createPilotAEvidenceInventory(bytes => writeFileSync(join(root, "evidence-inventory.json"), bytes, { mode: 0o600 }));
  const command = async (exe, argv, cwd = root) => {
    const name = inventory.declare(exe, argv);
    const r = await capturePilotA(nativeCaptureIO, exe, argv, { cwd, env }, root, name).settled;
    if (r.causes.length) throwCaptureCauses(r.causes);
    requireFact(r.birth && r.close && r.close.code === 0 && r.close.signal === null && r.rawComplete && !r.timedOut && !r.faults.length, `Command failed: ${name}`);
    const stdout = readFileSync(join(root, `${name}.stdout`)), stderr = readFileSync(join(root, `${name}.stderr`));
    inventory.record(name, stdout, stderr);
    return stdout.toString("utf8").trim();
  };
  try {
    const source = fileURLToPath(new URL("./macos-spi-pilot.c", import.meta.url));
    const repo = fileURLToPath(new URL("../../", import.meta.url));
    if (await command("/usr/bin/git", ["status", "--porcelain", "--untracked-files=normal"], repo) !== "") {
      Object.assign(report, { status: "ENVIRONMENT_BLOCKED", reason: "Clean approved commit required" }); save(); return report;
    }
    const xcode = await command("/usr/bin/xcodebuild", ["-version"]);
    const actual = buildPilotAProfile({
      profile: "macos-15-arm64", platform: process.platform, arch: process.arch, node_major: process.versions.node.split(".")[0],
      os_version: await command("/usr/bin/sw_vers", ["-productVersion"]), os_build: await command("/usr/bin/sw_vers", ["-buildVersion"]),
      darwin_release: await command("/usr/bin/uname", ["-r"]), image_version: process.env.ImageVersion,
      xcode_version: /^Xcode (.+)$/m.exec(xcode)?.[1], xcode_build: /^Build version (.+)$/m.exec(xcode)?.[1],
      sdk_version: await command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
      sdk_build: await command("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
      compiler_version: await command("/usr/bin/xcrun", ["--sdk", "macosx", "clang", "--version"]), developer_dir: developer,
      github_repository: process.env.GITHUB_REPOSITORY, commit: await command("/usr/bin/git", ["rev-parse", "HEAD"], repo),
      fixture_sha256: sha(readFileSync(source)), transport_sha256: sha(readFileSync(fileURLToPath(new URL("./macos-spi-transport.h", import.meta.url)))), harness_sha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    });
    persist(join(root, "actual-profile.json"), actual);
    const admission = admitPilotAProfile(expected, actual);
    if (!admission.admitted || actual.commit !== process.env.GITHUB_SHA || await command("/usr/bin/uname", ["-m"]) !== "arm64") {
      Object.assign(report, { status: "ENVIRONMENT_BLOCKED", reason: admission.reason ?? "Commit/native architecture mismatch" }); save(); return report;
    }
    const binary = join(root, "pilot-a");
    await command("/usr/bin/xcrun", ["--sdk", "macosx", "clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", "-arch", "arm64", source, "-lproc", "-o", binary]);
    persist(join(root, "binary.json"), { sha256: sha(readFileSync(binary)), source_sha256: actual.fixture_sha256, transport_sha256: actual.transport_sha256, abi: ABI });
    const frames = [];
    let stage = 0, refused = null;
    const lockFd = openSync(join(root, "transport.lock"), "wx", 0o600);
    const run = capturePilotA(nativeCaptureIO, binary, ["--execute-readonly-pilot-a"], { env, cwd: root, lockFd }, root, "driver", (frame, control) => {
      frames.push(frame);
      requireFact(frames.length <= 32, "Unexpected frame inventory");
      persist(join(root, "frames.json"), frames);
      if (refused) return;
      const next = nextPilotACommand(frames, control.birth, stage);
      if (next.refused) { refused = next.refused; control.abort(); return; }
      if (next.command && control.send(next.command)) stage = next.stage;
    }, () => closeSync(lockFd));
    const receipt = await run.settled;
    if (!receipt.birth) {
      if (receipt.causes.length) throwCaptureCauses(receipt.causes);
      throw Error("Driver launch has no captured birth; retained attempt is inconclusive");
    }
    const captured = new Map([["D", receipt.birth.pid]]);
    for (const b of frames.filter(r => r.event === "birth")) {
      requireFact(captured.get(b.parent_role) === b.parent_pid && !captured.has(b.role) && ![...captured.values(), receipt.birth.parent_pid].includes(b.pid), "Unproven birth: no absence probe for that target");
      captured.set(b.role, b.pid);
    }
    const probes = observePilotAAbsence([...captured.values()], p => process.kill(p, 0));
    persist(join(root, "absence.json"), probes);
    const projection = evaluatePilotA({ frames, driver: receipt.birth, close: receipt.close, rawComplete: receipt.rawComplete, timedOut: receipt.timedOut, faults: receipt.faults, absent: probes.filter(p => p.state === "absent").map(p => p.pid) });
    const inventoryDigest = projection.status === "PASS_A" ? inventory.finish() : null;
    Object.assign(report, projection, { gate_refusal: refused, evidence_inventory_sha256: inventoryDigest }); save(); return report;
  } catch (error) {
    report.status = "INCONCLUSIVE";
    report.reason = "Incomplete execution; retained original fault and effects";
    report.fault = describe(error); save(); return report;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const report = await executeCLI();
    console.log(JSON.stringify(report));
    if (report.status !== "PASS_A") process.exitCode = 1;
  } catch (error) {
    // An unexpected reporting/persistence failure may follow native effects.
    // Never relabel that as a refusal before execution.
    console.error(JSON.stringify({ status: "INCONCLUSIVE", reason: describe(error), c1_accepted: false, phase_b_admitted: false }));
    process.exitCode = 1;
  }
}
