// Owns: manual research-job envelope and frozen evidence, not native execution.
// Import is inert; local tests call pure guards, never the filesystem CLI below.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ABI, admitPilotAProfile, evaluatePilotA, parsePilotAFrame, readPilotAEvidenceInventory } from "./macos-spi-pilot.mjs";

const BASE = "/tmp/pi-actors-validation";
const WORK = join(BASE, "workflow");
const sourceNames = { fixture_sha256: "macos-spi-pilot.c", transport_sha256: "macos-spi-transport.h", harness_sha256: "macos-spi-pilot.mjs" };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const requireFact = (ok, message) => { if (!ok) throw Error(message); };

function requireWorkflowHost(context) {
  requireFact(context.ci === "true" && context.event === "workflow_dispatch" && context.attempt === "1", "First manual workflow attempt required");
  requireFact(context.platform === "darwin" && context.arch === "arm64" && context.node_major === "24" && context.uid > 0 && context.euid > 0, "Native ordinary-user first-profile host required");
  requireFact(/^[0-9]{1,24}$/.test(context.run_id) && /^[a-f0-9]{40}$/.test(context.sha) && context.sha === context.workflow_sha && typeof context.repository === "string" && context.repository.length > 0, "Missing or changed job identity");
}
export function verifyResearchOwner(context, marker) {
  requireWorkflowHost(context);
  requireFact(typeof marker === "string" && Buffer.byteLength(marker) <= 1024 && marker === [context.run_id, context.attempt, context.sha, context.workflow_sha, context.repository].join("\n") + "\n", "Evidence root is not owned by this job");
}
export function admitResearchRequest(input, context, sourceHashes) {
  requireWorkflowHost(context);
  requireFact(input.execute === "true", "Explicit native execution admission required");
  requireFact(/^[a-f0-9]{40}$/.test(input.commit) && input.commit === context.sha && input.commit === context.workflow_sha, "Approved source/dispatch/workflow commit mismatch");
  requireFact(typeof input.profile === "string" && Buffer.byteLength(input.profile) <= 65536 && /^[a-f0-9]{64}$/.test(input.profile_sha256) && sha(Buffer.from(input.profile)) === input.profile_sha256, "Reviewed UTF-8 profile digest mismatch");
  const profile = JSON.parse(input.profile);
  // This checks only the caller's declared profile shape/family. It neither
  // measures the host nor approves an actual tuple: the native harness owns that.
  requireFact(admitPilotAProfile(profile, profile).admitted, "Unreviewed declared profile schema/family");
  requireFact(profile.commit === context.sha && profile.github_repository === context.repository, "Profile commit/repository mismatch");
  for (const key of Object.keys(sourceNames)) requireFact(profile[key] === sourceHashes[key], `Reviewed source mismatch: ${key}`);
  return { profile, profile_sha256: input.profile_sha256, context, source_hashes: sourceHashes, native_admitted: false };
}

export function assessResearchResult(envelope, actualProfile, nativeReport, facts, binary, outcome) {
  const refusal = reason => ({ review_candidate: false, review_required: true, reason, c1_accepted: false, phase_b_admitted: false });
  if (outcome !== "success") return refusal(`Original native step outcome: ${outcome || "unavailable"}`);
  if (!envelope || !admitPilotAProfile(envelope.profile, actualProfile).admitted) return refusal("Actual profile is missing or differs from reviewed profile");
  if (!binary || binary.abi !== ABI || binary.source_sha256 !== envelope.source_hashes.fixture_sha256 || binary.transport_sha256 !== envelope.source_hashes.transport_sha256) return refusal("Compiled-source binding unavailable");
  const projection = evaluatePilotA(facts ?? {});
  if (nativeReport?.status !== "PASS_A" || projection.status !== "PASS_A" || nativeReport.c1_accepted !== false || nativeReport.phase_b_admitted !== false || nativeReport.exclusive_run_scope_proven !== false || nativeReport.gate_refusal !== null) return refusal("Native report/owner evidence is incomplete or non-pass");
  return { review_candidate: true, review_required: true, native_report_status: "PASS_A", c1_accepted: false, phase_b_admitted: false };
}

export const INVENTORY_COMMANDS = Object.freeze([
  { name: "git-status", command: "/usr/bin/git", args: ["status", "--porcelain", "--untracked-files=normal"] },
  { name: "git-head", command: "/usr/bin/git", args: ["rev-parse", "HEAD"] },
  { name: "os-version", command: "/usr/bin/sw_vers", args: ["-productVersion"] },
  { name: "os-build", command: "/usr/bin/sw_vers", args: ["-buildVersion"] },
  { name: "darwin-release", command: "/usr/bin/uname", args: ["-r"] },
  { name: "native-arch", command: "/usr/bin/uname", args: ["-m"] },
  { name: "xcode", command: "/usr/bin/xcodebuild", args: ["-version"] },
  { name: "sdk-version", command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-version"] },
  { name: "sdk-build", command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "--show-sdk-build-version"] },
  { name: "compiler", command: "/usr/bin/xcrun", args: ["--sdk", "macosx", "clang", "--version"] },
].map(spec => Object.freeze({ ...spec, args: Object.freeze(spec.args) })));
const INVENTORY_REQUEST_SCHEMA = "pi-actors-inventory-request-v1";
const INVENTORY_HOST_SCHEMA = "pi-actors-inventory-host-v1";
const INVENTORY_FILES = ["job-owner.txt", "prepare.stdout", "prepare.stderr", "inventory-request.json", "inventory-host.json", ...INVENTORY_COMMANDS.flatMap(c => ["stdout", "stderr", "code"].map(s => `inventory-${c.name}.${s}`))];

export function admitResearchMode(input, ctx) {
  requireWorkflowHost(ctx);
  requireFact(input.commit === ctx.sha && input.commit === ctx.workflow_sha, "Approved source/dispatch/workflow commit mismatch");
  requireFact((input.execute === "true" && input.inventory_only === "false") || (input.execute === "false" && input.inventory_only === "true"), "Exactly one explicit research mode required");
  if (input.inventory_only === "true") {
    requireFact(input.profile === "" && input.profile_sha256 === "", "Inventory cannot consume or approve a profile");
    return "inventory";
  }
  return "pilot_a";
}

export function buildResearchInventoryRequest(ctx, hashes) {
  requireWorkflowHost(ctx);
  for (const key of Object.keys(sourceNames)) requireFact(typeof hashes?.[key] === "string" && /^[a-f0-9]{64}$/.test(hashes[key]), "Inventory source hashes unavailable");
  return { schema: INVENTORY_REQUEST_SCHEMA, mode: "inventory", context: ctx, source_hashes: Object.fromEntries(Object.keys(sourceNames).map(key => [key, hashes[key]])), commands: INVENTORY_COMMANDS, profile_approved: false, native_admitted: false };
}

export function assessResearchInventory(request, host, records, inventoryOutcome, nativeOutcome) {
  const base = { review_candidate: false, review_required: true, profile_approved: false, pilot_executed: false, c1_accepted: false, phase_b_admitted: false };
  try {
    requireFact(inventoryOutcome === "success" && nativeOutcome === "skipped", "Inventory/native step outcomes do not establish inventory-only evidence");
    requireFact(request?.schema === INVENTORY_REQUEST_SCHEMA && request.mode === "inventory" && request.profile_approved === false && request.native_admitted === false && JSON.stringify(request.commands) === JSON.stringify(INVENTORY_COMMANDS), "Inventory request/declaration mismatch");
    requireWorkflowHost(request.context);
    requireFact(host?.schema === INVENTORY_HOST_SCHEMA, "Inventory host snapshot unavailable");
    for (const key of ["run_id", "attempt", "sha", "workflow_sha", "repository", "platform", "arch", "node_major", "uid", "euid"]) requireFact(host[key] === request.context[key], "Inventory host/job identity mismatch");
    const id = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
    requireFact(id(host.gid) && id(host.egid) && Array.isArray(host.groups) && host.groups.every(id) && new Set(host.groups).size === host.groups.length, "Inventory credential snapshot unavailable");
    const output = {};
    for (const spec of INVENTORY_COMMANDS) {
      const r = records[spec.name];
      requireFact(r && [r.stdout, r.stderr, r.code].every(b => Buffer.isBuffer(b) && b.length <= RESEARCH_EXPORT_LIMITS.file) && r.code.equals(Buffer.from("0\n")), "Inventory command receipt missing or nonzero");
      output[spec.name] = new TextDecoder("utf-8", { fatal: true }).decode(r.stdout);
    }
    requireFact(output["git-status"] === "" && output["git-head"].trim() === request.context.sha && output["native-arch"].trim() === "arm64", "Inventory source/native architecture mismatch");
    for (const key of Object.keys(sourceNames)) requireFact(typeof request.source_hashes?.[key] === "string" && /^[a-f0-9]{64}$/.test(request.source_hashes[key]), "Inventory source hashes unavailable");
    requireFact(typeof host.node_version === "string" && /^v24\./.test(host.node_version) && host.node_version.length <= 64, "Inventory Node version unavailable");
    const tuple = {
      platform: host.platform, arch: host.arch, node_major: host.node_major,
      os_version: output["os-version"].trim(), os_build: output["os-build"].trim(), darwin_release: output["darwin-release"].trim(), image_version: host.image_version,
      xcode_version: /^Xcode (.+)$/m.exec(output.xcode)?.[1], xcode_build: /^Build version (.+)$/m.exec(output.xcode)?.[1],
      sdk_version: output["sdk-version"].trim(), sdk_build: output["sdk-build"].trim(), compiler_version: output.compiler.trim(), developer_dir: host.developer_dir,
      github_repository: request.context.repository, commit: request.context.sha, ...Object.fromEntries(Object.keys(sourceNames).map(key => [key, request.source_hashes[key]])),
    };
    requireFact(Object.values(tuple).every(v => typeof v === "string" && v.length > 0 && v.length <= 4096) && tuple.developer_dir === "/Applications/Xcode_16.4.app/Contents/Developer", "Inventory tuple incomplete or developer directory changed");
    return { ...base, inventory_complete: true, status: "INVENTORY_ONLY", requested_profile: "macos-15-arm64", node_version: host.node_version, measured_tuple: tuple, credentials: { uid: host.uid, euid: host.euid, gid: host.gid, egid: host.egid, groups: [...host.groups] } };
  } catch (error) { return { ...base, inventory_complete: false, status: "INVENTORY_INCOMPLETE", reason: error.message }; }
}

function requestInput() {
  return { execute: process.env.RESEARCH_EXECUTE, inventory_only: process.env.RESEARCH_INVENTORY_ONLY, commit: process.env.RESEARCH_APPROVED_COMMIT, profile: process.env.RESEARCH_PROFILE_JSON ?? "", profile_sha256: process.env.RESEARCH_PROFILE_SHA256 ?? "" };
}
function context() {
  return {
    ci: process.env.CI, event: process.env.GITHUB_EVENT_NAME, attempt: process.env.GITHUB_RUN_ATTEMPT,
    sha: process.env.GITHUB_SHA, workflow_sha: process.env.GITHUB_WORKFLOW_SHA, repository: process.env.GITHUB_REPOSITORY,
    run_id: process.env.GITHUB_RUN_ID, platform: process.platform, arch: process.arch,
    node_major: process.versions.node.split(".")[0], uid: process.getuid?.(), euid: process.geteuid?.(),
  };
}
function save(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function prepare() {
  const ctx = context(); requireWorkflowHost(ctx);
  verifyResearchOwner(ctx, readFileSync(join(WORK, "job-owner.txt"), "utf8"));
  const hashes = Object.fromEntries(Object.entries(sourceNames).map(([key, name]) => [key, sha(readFileSync(fileURLToPath(new URL(name, import.meta.url))))]));
  const input = requestInput(), mode = admitResearchMode(input, ctx);
  if (mode === "inventory") {
    save(join(WORK, "inventory-request.json"), buildResearchInventoryRequest(ctx, hashes));
    save(join(WORK, "inventory-host.json"), { schema: INVENTORY_HOST_SCHEMA, ...ctx, gid: process.getgid(), egid: process.getegid(), groups: process.getgroups(), node_version: process.version, image_version: process.env.ImageVersion, developer_dir: process.env.DEVELOPER_DIR });
    return;
  }
  const envelope = admitResearchRequest(input, ctx, hashes);
  // Never write the profile into checkout or derive approved bytes from actuals.
  writeFileSync(join(WORK, "requested-profile.json"), input.profile, { flag: "wx", mode: 0o600 });
  save(join(WORK, "envelope.json"), envelope);
}

export const RESEARCH_EXPORT_LIMITS = Object.freeze({
  bytes: 33554432, slots: 256, file: 4194304, roots: 16,
  dataBytes: 32505856, dataSlots: 254, bootstrap: 1024, metadata: 1047552,
});
const EXPORT_SCHEMA = "pi-actors-research-export-v1";
const WORKFLOW_EVIDENCE = ["job-owner.txt", "requested-profile.json", "envelope.json", "prepare.stdout", "prepare.stderr", "harness.stdout", "harness.stderr"];

// Observed outcomes must come from the matching Actions job, not from the packet.
// A positive JSON file may survive a writer's later failure; it cannot attest
// successful completion of its own collector step.
export function admitResearchExport(manifest, expected, observed) {
  requireWorkflowHost(expected);
  const mode = observed?.mode ?? "pilot_a";
  requireFact((mode === "pilot_a" || mode === "inventory") && manifest?.mode === mode, "Export mode does not match external job mode");
  requireFact(observed?.collector === "success" && (mode === "pilot_a" ? observed.native === "success" : observed.native === "skipped" && observed.inventory === "success"), "External native/collector outcomes do not permit export acceptance");
  requireFact(manifest?.schema === EXPORT_SCHEMA && manifest.evidence_complete === true && manifest.review_required === true && manifest.native_outcome === observed.native && (mode === "pilot_a" ? manifest.review_candidate === true : manifest.review_candidate === false && manifest.inventory_complete === true && manifest.inventory_outcome === observed.inventory && manifest.profile_approved === false && manifest.pilot_executed === false && manifest.status === "INVENTORY_ONLY"), "Export manifest is not complete");
  requireFact(manifest.c1_accepted === false && manifest.phase_b_admitted === false && Array.isArray(manifest.faults) && manifest.faults.length === 0 && manifest.faults_omitted === 0, "Export has faults or changed authority");
  requireFact(Array.isArray(manifest.files) && Array.isArray(manifest.failed_copies) && manifest.failed_copies.length === 0 && manifest.files_omitted === 0, "Export inventory is incomplete");
  requireFact(Number.isSafeInteger(manifest.reserved_bytes) && manifest.reserved_bytes >= 0 && manifest.reserved_bytes <= RESEARCH_EXPORT_LIMITS.dataBytes && Number.isSafeInteger(manifest.copy_slots) && manifest.copy_slots >= manifest.files.length && manifest.copy_slots <= RESEARCH_EXPORT_LIMITS.dataSlots, "Export budget receipt is invalid");
  const paths = new Set(); let total = 0;
  for (const file of manifest.files) {
    const parts = typeof file?.path === "string" ? file.path.split("/") : [];
    requireFact(parts.length === 2 && (parts[0] === "workflow" || /^mac-a-[A-Za-z0-9]+$/.test(parts[0])) && parts[1] !== "." && parts[1] !== ".." && parts[1].length > 0 && !paths.has(file.path), "Export file reference is invalid");
    requireFact(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= RESEARCH_EXPORT_LIMITS.file && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256), "Export file receipt is invalid");
    paths.add(file.path); total += file.bytes;
  }
  requireFact(total <= manifest.reserved_bytes && (mode === "inventory" ? INVENTORY_FILES : WORKFLOW_EVIDENCE).every(file => paths.has("workflow/" + file)), "Export byte/inventory receipt is incomplete");
  if (mode === "inventory") requireFact([...paths].every(path => path.startsWith("workflow/") && !["requested-profile.json", "envelope.json", "harness.stdout", "harness.stderr"].includes(path.slice(9))), "Inventory export contains pilot evidence");
  for (const key of ["run_id", "attempt", "sha", "workflow_sha", "repository"]) requireFact(manifest.job?.[key] === expected[key], "Export belongs to another job");
  return { review_candidate: mode === "pilot_a", review_required: true, ...(mode === "inventory" ? { inventory_complete: true, profile_approved: false, pilot_executed: false } : {}), native_outcome: observed.native, collector_outcome: observed.collector, c1_accepted: false, phase_b_admitted: false };
}

export function collectResearchEvidence(io, base, outcome, options = {}) {
  const mode = options.mode ?? "pilot_a", workflowFiles = mode === "inventory" ? INVENTORY_FILES : WORKFLOW_EVIDENCE;
  requireFact(mode === "pilot_a" || mode === "inventory", "Unknown research export mode");
  const bundle = join(base, "bundle"), limits = RESEARCH_EXPORT_LIMITS;
  io.mkdirSync(bundle, { mode: 0o700 }); // no reuse, overwrite or removal of old evidence
  const manifest = {
    schema: EXPORT_SCHEMA, mode, review_candidate: false, evidence_complete: false, review_required: true,
    ...(mode === "inventory" ? { inventory_complete: false, status: "INVENTORY_INCOMPLETE", profile_approved: false, pilot_executed: false, inventory_outcome: options.inventory_outcome ?? "unavailable" } : {}),
    native_outcome: outcome ?? "unavailable", job: null, files: [], failed_copies: [], faults: [],
    faults_omitted: 0, files_omitted: 0, reserved_bytes: 0, copy_slots: 0,
    excluded_non_evidence: ["home", "tmp", "clang-cache"], c1_accepted: false, phase_b_admitted: false,
  };
  const snapshots = new Map(), causes = [], attempted = new Set(), directories = [];
  Object.defineProperty(manifest, "causes", { value: causes }); // private exact originals, not artifact JSON
  const retainFault = error => {
    causes.push(error);
    const fault = { type: typeof error };
    try {
      const d = error !== null && (typeof error === "object" || typeof error === "function") ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
      if (d && Object.hasOwn(d, "value") && typeof d.value === "string") {
        if (Buffer.byteLength(d.value) <= 4096) fault.message = d.value;
        else fault.message_unavailable = "Diagnostic exceeds 4096 UTF-8 bytes";
      }
    } catch (summaryError) { causes.push(summaryError); fault.message_unavailable = "Diagnostic extraction failed"; }
    if (manifest.faults.length < 256) manifest.faults.push(fault);
    else manifest.faults_omitted++;
  };
  const copy = (name, file) => {
    const key = name + "/" + file;
    if (attempted.has(key)) return;
    attempted.add(key);
    let writing = false;
    try {
      const from = join(base, name, file), stat = io.lstatSync(from);
      if (stat.isDirectory() && manifest.excluded_non_evidence.includes(file) && name !== "workflow") return;
      requireFact(stat.isFile() && !stat.isSymbolicLink(), "Unexpected non-regular evidence entry");
      requireFact(manifest.copy_slots < limits.dataSlots, "Evidence file-slot budget exceeded");
      manifest.copy_slots++; // failed attempts cannot free a slot for another output file
      requireFact(Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= limits.file && manifest.reserved_bytes + stat.size <= limits.dataBytes, "Evidence byte budget exceeded; no silent truncation");
      manifest.reserved_bytes += stat.size;
      const bytes = io.readFileSync(from);
      requireFact(Buffer.isBuffer(bytes) && bytes.length <= limits.file, "Evidence grew beyond file budget");
      const growth = Math.max(0, bytes.length - stat.size);
      requireFact(manifest.reserved_bytes + growth <= limits.dataBytes, "Evidence grew beyond total budget");
      manifest.reserved_bytes += growth; // reserve before write, never refund uncertain effects
      writing = true;
      io.writeFileSync(join(bundle, name, file), bytes, { flag: "wx", mode: 0o600 });
      snapshots.set(key, bytes);
      manifest.files.push({ path: key, bytes: bytes.length, sha256: sha(bytes) });
    } catch (error) {
      if (writing) manifest.failed_copies.push({ path: key, state: "write_failed_bytes_unconfirmed" });
      manifest.files_omitted++;
      retainFault(error);
    }
  };
  let roots = [];
  try {
    roots = io.readdirSync(base).filter(name => /^mac-a-[A-Za-z0-9]+$/.test(name)).sort();
    requireFact(roots.length <= limits.roots, "Evidence root budget exceeded");
    for (const name of ["workflow", ...roots]) {
      try {
        const dir = join(base, name), stat = io.lstatSync(dir);
        requireFact(stat.isDirectory() && !stat.isSymbolicLink(), "Evidence root is not an owned directory");
        io.mkdirSync(join(bundle, name), { mode: 0o700 });
        directories.push({ name, files: io.readdirSync(dir).sort() });
      } catch (error) { retainFault(error); }
    }
    if (directories.some(d => d.name === "workflow")) for (const file of workflowFiles) copy("workflow", file);
    // All mandatory lists are derived from frozen producer inventories before
    // any optional files can spend the remaining budget.
    for (const { name } of directories.filter(d => d.name !== "workflow")) copy(name, "evidence-inventory.json");
    for (const { name } of directories.filter(d => d.name !== "workflow")) {
      try {
        const bytes = snapshots.get(name + "/evidence-inventory.json");
        requireFact(bytes, "Producer inventory is unavailable for salvage ordering");
        const inventory = readPilotAEvidenceInventory(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        for (const file of inventory.files) copy(name, file);
      } catch (error) { retainFault(error); }
    }
    for (const { name, files } of directories) for (const file of files) copy(name, file);
    if (causes.length === 0 && mode === "inventory") {
      const get = name => {
        const bytes = snapshots.get("workflow/" + name);
        requireFact(bytes, "Missing inventory evidence: " + name);
        return bytes;
      };
      const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(get("inventory-request.json")));
      verifyResearchOwner(request.context, new TextDecoder("utf-8", { fatal: true }).decode(get("job-owner.txt")));
      manifest.job = Object.fromEntries(["run_id", "attempt", "sha", "workflow_sha", "repository"].map(key => [key, request.context[key]]));
      requireFact(roots.length === 0 && !["requested-profile.json", "envelope.json", "harness.stdout", "harness.stderr"].some(name => snapshots.has("workflow/" + name)), "Inventory-only job contains pilot evidence");
      for (const file of workflowFiles) get(file);
      const records = Object.fromEntries(INVENTORY_COMMANDS.map(c => [c.name, Object.fromEntries(["stdout", "stderr", "code"].map(s => [s, get(`inventory-${c.name}.${s}`)]))]));
      Object.assign(manifest, assessResearchInventory(request, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(get("inventory-host.json"))), records, manifest.inventory_outcome, manifest.native_outcome));
    }
    if (causes.length === 0 && mode === "pilot_a") {
      const required = key => { requireFact(snapshots.has(key), `Missing required evidence: ${key}`); return snapshots.get(key); };
      const json = key => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(required(key)));
      for (const name of WORKFLOW_EVIDENCE) required(`workflow/${name}`);
      const envelope = json("workflow/envelope.json");
      verifyResearchOwner(envelope.context, new TextDecoder("utf-8", { fatal: true }).decode(required("workflow/job-owner.txt")));
      manifest.job = Object.fromEntries(["run_id", "attempt", "sha", "workflow_sha", "repository"].map(key => [key, envelope.context[key]]));
      requireFact(sha(required("workflow/requested-profile.json")) === envelope.profile_sha256 && admitPilotAProfile(envelope.profile, json("workflow/requested-profile.json")).admitted, "Frozen reviewed profile bytes/digest mismatch");
      requireFact(roots.length === 1, "No native witness root");
      const prefix = roots[0] + "/", get = name => json(prefix + name);
      const report = get("report.json"), birth = get("driver.birth.json"), close = get("driver.close.json"), exit = get("driver.exit.json");
      const inventoryBytes = required(prefix + "evidence-inventory.json"), inventory = readPilotAEvidenceInventory(get("evidence-inventory.json"));
      requireFact(inventory.complete && sha(inventoryBytes) === report.evidence_inventory_sha256, "Missing, incomplete or mismatched producer inventory");
      for (const file of inventory.files) required(prefix + file);
      const declared = new Set(inventory.files);
      for (const key of snapshots.keys()) if (key.startsWith(prefix + "preflight-")) requireFact(declared.has(key.slice(prefix.length)), "Undeclared preflight evidence");
      for (const preflight of inventory.preflights) {
        const captured = get(`${preflight.name}.birth.json`), settled = get(`${preflight.name}.close.json`), exited = get(`${preflight.name}.exit.json`);
        const { pid, ...attempt } = captured;
        requireFact(Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff && captured.parent_pid === birth.parent_pid && JSON.stringify(captured.credentials) === JSON.stringify(birth.credentials), "Preflight parent/identity mismatch");
        requireFact(captured.command === preflight.command && JSON.stringify(captured.args) === JSON.stringify(preflight.args), "Preflight declaration/captured command mismatch");
        requireFact(JSON.stringify(settled.birth) === JSON.stringify(captured) && JSON.stringify(settled.attempt) === JSON.stringify(attempt), "Preflight attempt/birth/close mismatch");
        requireFact(settled.close?.code === 0 && settled.close.signal === null && exited.code === 0 && exited.signal === null && settled.rawComplete === true && settled.timedOut === false && Array.isArray(settled.faults) && settled.faults.length === 0, "Preflight did not settle with complete IO");
        for (const stream of ["stdout", "stderr"]) {
          const bytes = required(`${prefix}${preflight.name}.${stream}`), expected = preflight.stdio[stream];
          requireFact(bytes.length === expected.bytes && sha(bytes) === expected.sha256, "Preflight raw bytes/digest mismatch");
        }
      }
      requireFact(report.retained_root === join(base, roots[0]), "Report root mismatch");
      requireFact(JSON.stringify(json("workflow/harness.stdout")) === JSON.stringify(report), "CLI result differs from retained report");
      requireFact(admitPilotAProfile(envelope.profile, get("requested-profile.json")).admitted, "Native requested profile changed");
      requireFact(JSON.stringify(close.birth) === JSON.stringify(birth) && exit.code === close.close.code && exit.signal === close.close.signal, "Actual driver birth/exit/close mismatch");
      const raw = snapshots.get(prefix + "driver.stdout");
      requireFact(raw && raw.length > 0 && raw.at(-1) === 10 && snapshots.has(prefix + "driver.stderr"), "Missing/partial raw driver stdio");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const frames = decoded.slice(0, -1).split("\n").map(parsePilotAFrame);
      requireFact(JSON.stringify(frames) === JSON.stringify(get("frames.json")), "Raw stdout/retained frames differ");
      const binary = get("binary.json");
      requireFact(sha(snapshots.get(prefix + "pilot-a")) === binary.sha256, "Binary digest mismatch");
      const absence = get("absence.json");
      requireFact(Array.isArray(absence) && absence.every(p => p.state === "absent" && p.cause?.code === "ESRCH"), "Fresh absence receipt unavailable");
      const facts = { frames, driver: birth, close: close.close, absent: absence.map(p => p.pid), rawComplete: close.rawComplete, timedOut: close.timedOut, faults: close.faults };
      Object.assign(manifest, assessResearchResult(envelope, get("actual-profile.json"), report, facts, binary, manifest.native_outcome));
    }
  } catch (error) { retainFault(error); }
  return persistCollection();
  function persistCollection() {
    manifest.evidence_complete = mode === "inventory" ? manifest.inventory_complete === true : manifest.review_candidate;
    let bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (bytes.length > limits.metadata) {
      retainFault(Error("Export metadata budget exceeded"));
      manifest.review_candidate = false; manifest.evidence_complete = false;
      if (mode === "inventory") { manifest.inventory_complete = false; manifest.status = "INVENTORY_INCOMPLETE"; }
      manifest.files_omitted += manifest.files.length; manifest.files = [];
      manifest.faults_omitted += Math.max(0, manifest.faults.length - 8); manifest.faults = manifest.faults.slice(0, 8);
      manifest.failed_copies_omitted = manifest.failed_copies.length; manifest.failed_copies = [];
      manifest.metadata_summary = "Non-pass bounded summary; inventories/diagnostics explicitly omitted";
      bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    }
    try {
      requireFact(bytes.length <= limits.metadata, "Bounded summary exceeds metadata reserve");
      io.writeFileSync(join(bundle, "collection.json"), bytes, { flag: "wx", mode: 0o600 });
    }
    catch (error) {
      if (causes.length) throw new AggregateError([...causes, error], "Evidence collection and manifest persistence failed");
      throw error;
    }
    return manifest;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv[2] === "prepare" && process.argv.length === 3) prepare();
    else if (process.argv[2] === "collect" && process.argv.length === 3) {
      const ctx = context(); requireWorkflowHost(ctx);
      verifyResearchOwner(ctx, readFileSync(join(WORK, "job-owner.txt"), "utf8"));
      const mode = admitResearchMode(requestInput(), ctx);
      const manifest = collectResearchEvidence({ mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync }, BASE, process.env.RESEARCH_NATIVE_OUTCOME, { mode, inventory_outcome: process.env.RESEARCH_INVENTORY_OUTCOME });
      console.log(JSON.stringify({ mode, review_candidate: manifest.review_candidate, inventory_complete: manifest.inventory_complete, profile_approved: false, native_outcome: manifest.native_outcome, review_required: true }));
      if (!manifest.evidence_complete) process.exitCode = 1;
    }
    else if (process.argv[2] === "admit" && process.argv.length === 3) {
      const ctx = context(); requireWorkflowHost(ctx);
      verifyResearchOwner(ctx, readFileSync(join(WORK, "job-owner.txt"), "utf8"));
      const path = join(BASE, "bundle", "collection.json"), stat = lstatSync(path);
      requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.size <= RESEARCH_EXPORT_LIMITS.metadata, "Export manifest is not bounded regular evidence");
      const bytes = readFileSync(path);
      requireFact(bytes.length <= RESEARCH_EXPORT_LIMITS.metadata, "Export manifest grew beyond metadata reserve");
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      console.log(JSON.stringify(admitResearchExport(manifest, ctx, { mode: admitResearchMode(requestInput(), ctx), inventory: process.env.RESEARCH_INVENTORY_OUTCOME, native: process.env.RESEARCH_NATIVE_OUTCOME, collector: process.env.RESEARCH_COLLECTOR_OUTCOME })));
    }
    else throw Error("Research envelope command must be prepare, collect or admit");
  } catch (error) { console.error("Research envelope failed:", error); process.exitCode = 1; }
}
