import "./test-environment.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";

// Read only compiler headers, then consume declared UTF-16 lengths; authored body delimiters stay opaque.
function coreRows(text: string): Array<{ metadata: any; parts: Array<{ body: string } | { marker: string }> }> {
  const rows: Array<{ metadata: any; parts: Array<{ body: string } | { marker: string }> }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const framed = text.startsWith("---\n", cursor);
    const start = cursor + (framed ? 4 : 0);
    const end = framed ? text.indexOf("\n---\n", start) : text.indexOf("\n\n", start);
    assert.ok(!framed || end >= start);
    const headerEnd = end < 0 ? text.length : end;
    const doc = parseDocument(text.slice(start, headerEnd), { uniqueKeys: true });
    assert.deepEqual(doc.errors, []);
    const metadata = doc.toJS(); assert.ok(metadata && !Array.isArray(metadata));
    cursor = end < 0 ? text.length : end + (framed ? 5 : 2);
    const parts = (metadata._completion?.parts ?? []).map((part: any) => {
      const kind = Object.hasOwn(part, "body") ? "body" : "marker";
      assert.deepEqual(Object.keys(part), [kind]); assert.ok(Number.isSafeInteger(part[kind]) && part[kind] >= 0);
      const value = text.slice(cursor, cursor + part[kind]); assert.equal(value.length, part[kind]); cursor += part[kind];
      return { [kind]: value };
    });
    rows.push({ metadata, parts });
    if (framed && cursor < text.length) { assert.equal(text.slice(cursor, cursor + 2), "\n\n"); cursor += 2; }
  }
  return rows;
}

function rootedEntries(metadata: any): any[] {
  return (metadata.files?.groups ?? []).flatMap((group: any) => group.entries.map((entry: any) => ({ ...entry, root: group.root })));
}

function rootedNavigation(metadata: any): any {
  const { group, ...observation } = metadata.files?.observation ?? {};
  if (group === undefined) return undefined;
  const root = metadata.files.groups[group].root;
  const files = rootedEntries(metadata).filter(entry => entry.format_hint !== undefined).map(({ root, purpose, path, ...facts }) =>
    ({ ...facts, path: path === null ? null : join(root, path) }));
  return { run: observation.run, run_instance_id: observation.run_instance_id, locations: { ...observation, directory: root, files } };
}

import * as Limits from "../lib/limits.ts";
import { renderYamlMetadata } from "../lib/tools-response.ts";

// Independent canonical assembly: only scalar spelling uses the pure metadata lowerer.
// No product encoder, decoder, projector or fitter supplies expected fields/costs.
function candidateProofWire(packet: CompletionYamlPacket): string {
  // These independently authored fixtures use canonical native paths only. The production path splitter
  // is deliberately not used: this oracle uses native relative/dirname/basename for the known fixtures.
  const service: any = { header_layout: "rooted_files_v2", ...packet.service };
  if (service.result_inventory) service.result_inventory = { ...service.result_inventory,
    path: basename(service.result_inventory.path), root: dirname(service.result_inventory.path) };
  packet = { ...packet, service, records: packet.records.map(row => {
    const { references = {}, run_files, ...metadata } = row.metadata as any;
    if (service.header_layout === "rooted_files_v2" && packet.records.length === 1) delete metadata.index;
    const groups: any[] = [], files: any = {};
    const locations = run_files?.locations, runRoot = locations?.state === "available" ? locations.directory : undefined;
    let best = Infinity;
    const group = (root: string | null) => {
      let index = groups.findIndex(item => item.root === root);
      if (index < 0) { index = groups.length; groups.push({ root, entries: [] }); }
      return index;
    };
    const add = (path: string | null, entry: any, rank = Infinity, base?: string) => {
      const within = typeof path === "string" && runRoot && !relative(runRoot, path).startsWith("..") && !isAbsolute(relative(runRoot, path));
      const root = typeof path === "string" && isAbsolute(path) ? within ? runRoot : dirname(path) : base ?? null;
      const selected = typeof path === "string" && isAbsolute(path) ? within ? relative(runRoot, path) : basename(path) : path;
      const index = group(root); groups[index].entries.push({ ...entry, path: selected });
      if (typeof path === "string" && isAbsolute(path) && rank < best) {
        best = rank; files.read_first = { group: index, entry: groups[index].entries.length - 1 };
      }
    };
    const notes = { ...references };
    for (const [role, purpose, rank] of [["primary", "Full result text", 0], ["diagnostic_metadata", "Recorded error and command metadata", 1],
      ["artifact_inventory", "Declared artifact inventory; target availability unproven", 2]] as const) {
      if (!references[role]) continue;
      const { source: { path, ...source }, ...facts } = references[role];
      add(path, { role, purpose, ...facts, source }, rank); delete notes[role];
    }
    if (references.artifacts) {
      for (const declaration of references.artifacts.declarations)
        add(declaration.path, { role: "artifact", purpose: "Declared artifact", name: declaration.name, scope: references.artifacts.scope, state: "declared" });
      delete notes.artifacts;
    }
    if (locations?.state === "available") {
      const { directory, files: entries, ...observation } = locations;
      files.observation = { ...observation, group: group(directory) };
      for (const { path, ...facts } of entries) add(path, { ...facts, purpose: facts.role === "result" ? "Recorded result metadata"
        : facts.role === "execution" ? "Recorded execution and capture locations" : "Recorded Run file" },
        facts.state === "present" && facts.role === "result" ? 3 : facts.state === "present" && facts.role === "execution" ? 4 : Infinity, directory);
    } else if (locations) files.observation = locations;
    if (groups.length) {
      files.groups = groups;
    }
    if (Object.keys(notes).length) files.notes = notes;
    if (Object.keys(files).length) metadata.files = files;
    const parts = [...row.parts];
    if (parts.some(part => "marker" in part && part.marker === "Run-file reference omitted (packet byte limit).")) {
      metadata.run_files_omission = { reason: "packet_byte_limit", shown: 0, omitted: 1, total: 1 };
      parts.splice(-2);
    }
    return { metadata, parts };
  }) };
  return Array.from({ length: Math.max(1, packet.records.length) }, (_, index) => {
    const row = packet.records[index], bookkeeping = {
      ...(index === 0 ? { codec: "completion_yaml_core_v1", batch_id: packet.batchId, ...(packet.service ? { service: packet.service } : {}) } : {}),
      ...(row?.parts.length ? { parts: row.parts.map(part => "body" in part ? { body: part.body.length } : { marker: part.marker.length }) } : {}),
    };
    const rendered = renderYamlMetadata({ ...row?.metadata, ...(Object.keys(bookkeeping).length ? { _completion: bookkeeping } : {}) }, 49152);
    assert.equal(rendered.state, "available");
    if (rendered.state !== "available") throw new Error("Independent metadata spelling unavailable");
    return (row?.parts.length ? `---\n${rendered.text}---\n` : rendered.text)
      + (row?.parts.map(part => "body" in part ? part.body : part.marker).join("") ?? "")
      + (index + 1 < packet.records.length ? row?.parts.length ? "\n\n" : "\n" : "");
  }).join("");
}

function candidateProofPrimary(item: RunCompletionBatchMember, index: number, raw: string, quota: number): CompletionYamlPacket["records"][number] {
  let body = "", bytes = 0;
  for (const scalar of raw) {
    bytes += Buffer.byteLength(scalar);
    if (bytes > quota) break;
    body += scalar;
  }
  if (body.endsWith("\r") && raw[body.length] === "\n") body = body.slice(0, -1);
  const omitted = [...raw].length - [...body].length;
  return { metadata: { index, run: item.run, state: item.status, kind: "primary", redacted: true,
    references: { primary: { scope: "Exported primary text at capture; admission privacy, not complete Actor output.",
      redacted: true, source: { ...item.primary_text!.output!.source } } } },
    parts: [{ body }, ...(omitted ? [{ marker: "\n" }, { marker: `[${omitted} characters omitted]` }] : [])] };
}

test("Candidate q gap attributes minimal row cap independently of bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-q-gap-cap-"));
  try {
    const members = Array.from({ length: 65 }, (_, i) => {
      const { artifacts, ...base } = member(`minimal-${i}`);
      return { ...base, summary: "Run completed." };
    });
    const input = { ownerId: "minimal", batchId: "minimal", tempDir: root, members, now: new Date("2026-08-31T12:00:00.000Z") };
    const inventory = `${JSON.stringify({ schema: "run-completion-inventory-v1", batch_id: input.batchId, created_at: input.now.toISOString(),
      scope: "captured_completion_members", members_total: 65, artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
      members: members.map(m => ({ run: m.run, run_instance_id: m.run_instance_id, status: m.status, terminal_at: m.terminal_at })) }, null, 2)}\n`;
    const hash = createHash("sha256").update(inventory).digest("hex");
    const source = { path: join(dirname(getRunDeliveryJournalPath(root, input.ownerId)), `inventory-${hash}.json`), sha256: hash, bytes_total: Buffer.byteLength(inventory), members_total: 65 };
    const records = members.map((m, index) => ({ metadata: { index, run: m.run, state: "done", result_state: "not captured" }, parts: [] }));
    // Unadmitted 65-row arithmetic only; overcharge even the real omitted-result service and inventory.
    const service = { omitted_results: 1, result_inventory: source };
    const upperBound = Buffer.byteLength(candidateProofWire({ batchId: input.batchId, records, service }));
    assert.ok(upperBound < 49152);
    const batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input);
    const wire = candidateProofWire({ batchId: input.batchId, records: records.slice(0, 64), service });
    assert.equal(batch.members.length, 65); assert.deepEqual(batch.members, members);
    assert.deepEqual(batch.inventory_source, source); assert.equal(fs.readFileSync(source.path, "utf8"), inventory);
    for (const phase of ["pending", "queued", "presented"] as const) {
      if (phase === "queued") assert.equal(markRunCompletionBatchQueued(input), true);
      if (phase === "presented") assert.equal(markRunCompletionBatchPresented(input), true);
      const saved = readRunDeliveryJournal(root, input.ownerId).completion_batch!;
      assert.equal(saved.phase, phase); assert.equal(saved.text_budget, batch.text_budget);
      assert.deepEqual(saved.members, members); assert.deepEqual(saved.inventory_source, source);
      assert.equal(projectRunCompletionBatchPresentation(saved).content, wire);
    }
    console.log("q-gap-cap", JSON.stringify({ captured: 65, shown: 64, omitted: 1, upperBound, bytes: Buffer.byteLength(wire), quota: batch.text_budget }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate q gap omits a whole byte-forced Run-file reference on fresh capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-q-gap-files-"));
  try {
    const raw = "x".repeat(49152);
    const { artifacts, ...base } = member("located");
    const item = { ...base, state_dir: resolve(root, "p".repeat(200)), summary: "Run completed." };
    const members = [{ ...item, primary_text: primaryBinding(item, "", raw), completion_text: { text: raw, shown_bytes: { start: 0, end: raw.length } } }];
    const locations = capturedLocations(members), input = { ownerId: "files", batchId: "files", tempDir: root, members, fileNavigation: locations };
    const batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input);
    const marker = "Run-file reference omitted (packet byte limit).";
    const row = candidateProofPrimary(members[0]!, 0, raw, batch.text_budget!);
    const fullRow = { metadata: { ...row.metadata, run_files: { run: item.run, run_instance_id: item.run_instance_id,
      locations: { ...locations[0]!.locations, files: locations[0]!.locations.files.map(({ mutable, ...file }) => ({ ...file, mutable })) } } }, parts: row.parts };
    const lowerBound = Buffer.byteLength(candidateProofWire({ batchId: input.batchId, records: [fullRow] }));
    assert.ok(lowerBound > 49152, "A complete reference cannot fit even after removing the omission marker");
    const records = [{ ...row, parts: [...row.parts, { marker: "\n" }, { marker }] }];
    const wire = candidateProofWire({ batchId: input.batchId, records });
    assert.ok(Buffer.byteLength(wire) <= 49152);
    assert.deepEqual(batch.file_navigation, locations);
    assert.equal(batch.members[0]!.completion_text!.text, raw.slice(0, batch.text_budget));
    for (const phase of ["pending", "queued", "presented"] as const) {
      if (phase === "queued") assert.equal(markRunCompletionBatchQueued(input), true);
      if (phase === "presented") assert.equal(markRunCompletionBatchPresented(input), true);
      const saved = readRunDeliveryJournal(root, input.ownerId).completion_batch!;
      assert.equal(saved.phase, phase); assert.equal(saved.text_budget, batch.text_budget);
      assert.deepEqual(saved.file_navigation, locations); assert.deepEqual(saved.members, batch.members);
      assert.equal(projectRunCompletionBatchPresentation(saved).content, wire);
    }
    console.log("q-gap-files", JSON.stringify({ captured: 1, referencesShown: 0, referencesOmitted: 1, lowerBound, bytes: Buffer.byteLength(wire), quota: batch.text_budget }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Fresh private candidate captures, not relabeled legacy snapshots or producer grants.
test("Candidate q proof independently maximizes frozen equal shares including inventory and decimal costs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-q-"));
  try {
    for (const [count, length, short] of [[13, 10000, false], [64, 1099, false], [65, 1099, true], [256, 1099, false]] as const) {
      const ownerId = `q-${count}`, input = { ownerId, tempDir: root, batchId: ownerId, now: new Date("2026-08-31T12:00:00.000Z") };
      const texts = Array.from({ length: count }, (_, index) => short && index === 0 ? "ok" : "x".repeat(length));
      const members = texts.map((raw, index) => {
        const base = { ...member(`q-${String(index).padStart(3, "0")}`), artifacts: undefined, summary: "Run completed." };
        // Empty descriptor preview avoids journal copies; completion_text is the actual selected capture input.
        return { ...base, primary_text: primaryBinding(base, "", raw), completion_text: { text: raw, shown_bytes: { start: 0, end: Buffer.byteLength(raw) } } };
      });
      const original = JSON.stringify(members), batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch({ ...input, members });
      const shown = Math.min(64, count);
      const inventoryText = `${JSON.stringify({ schema: "run-completion-inventory-v1", batch_id: ownerId, created_at: input.now.toISOString(),
        scope: "captured_completion_members", members_total: count, artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
        members: members.map(item => ({ run: item.run, run_instance_id: item.run_instance_id, status: item.status, terminal_at: item.terminal_at, primary_text: item.primary_text })) }, null, 2)}\n`;
      const inventoryHash = createHash("sha256").update(inventoryText).digest("hex");
      const inventorySource = { path: join(dirname(getRunDeliveryJournalPath(root, ownerId)), `inventory-${inventoryHash}.json`), sha256: inventoryHash,
        bytes_total: Buffer.byteLength(inventoryText), members_total: count };
      assert.deepEqual(batch.inventory_source, count > 64 ? inventorySource : undefined);
      const service = count > 64 ? { omitted_results: count - shown, result_inventory: inventorySource } : undefined;
      const expected = (quota: number): CompletionYamlPacket => ({ batchId: ownerId,
        records: members.slice(0, shown).map((item, index) => candidateProofPrimary(item, index, texts[index]!, quota)), ...(service ? { service } : {}) });
      // Exhaust every integer share, including all decimal/scaffolding discontinuities; no monotonicity assumption.
      const maximum = Math.floor(49152 / shown);
      let best = -1;
      for (let quota = 0; quota <= maximum; quota++) if (Buffer.byteLength(candidateProofWire(expected(quota))) <= 49152) best = quota;
      assert.ok(best >= 0 && best < maximum);
      assert.equal(batch.text_budget, best);
      const wire = candidateProofWire(expected(best)), nextBytes = Buffer.byteLength(candidateProofWire(expected(best + 1)));
      assert.ok(nextBytes > 49152);
      assert.equal(projectRunCompletionBatchPresentation(batch).content, wire);
      assert.equal(JSON.stringify(members), original);
      assert.deepEqual(batch.members.slice(0, shown).map(item => item.completion_text!.text), texts.slice(0, shown).map(raw => raw.slice(0, best)));
      assert.ok(batch.members.slice(shown).every(item => item.completion_text === undefined));
      if (short) {
        assert.equal(batch.members[0]!.completion_text!.text, "ok");
        assert.ok(batch.members.slice(1, shown).every(item => item.completion_text!.text.length === best), "Unused short share is not redistributed");
      }
      if (count === 64) {
        const at99 = Buffer.byteLength(candidateProofWire(expected(99))), at100 = Buffer.byteLength(candidateProofWire(expected(100)));
        assert.equal(at100 - at99, 64, "Body +1 and descriptor +1 offset omitted-count -1 at 1000 to 999");
      }
      if (batch.inventory_source) {
        const source = batch.inventory_source, content = fs.readFileSync(source.path);
        assert.equal(content.toString(), inventoryText);
        assert.equal(source.sha256, createHash("sha256").update(content).digest("hex"));
        assert.equal(source.bytes_total, content.length); assert.equal(source.members_total, count);
        const inventory = JSON.parse(content.toString());
        assert.equal(inventory.scope, "captured_completion_members");
        assert.deepEqual(inventory.members.map((item: any) => ({ run: item.run, run_instance_id: item.run_instance_id, status: item.status, terminal_at: item.terminal_at })),
          members.map(item => ({ run: item.run, run_instance_id: item.run_instance_id, status: item.status, terminal_at: item.terminal_at })));
      }
      for (const phase of ["pending", "queued", "presented"] as const) {
        if (phase === "queued") assert.equal(markRunCompletionBatchQueued(input), true);
        if (phase === "presented") assert.equal(markRunCompletionBatchPresented(input), true);
        const reopened = readRunDeliveryJournal(root, ownerId).completion_batch!;
        assert.equal(reopened.phase, phase); assert.equal(reopened.text_budget, best);
        assert.equal(projectRunCompletionBatchPresentation(reopened).content, wire);
        assert.deepEqual(reopened.members, batch.members);
      }
      console.log("candidate-q", JSON.stringify({ count, shown, best, bytes: Buffer.byteLength(wire), nextBytes, maximum, inventoryBytes: batch.inventory_source?.bytes_total }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate q proof separates source-compatible byte omissions from the row cap and unsupported data", async () => {
  const { describeRunArtifactReferences } = await import("../lib/runs-artifacts.ts");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-q-regions-"));
  try {
    // Each path is a bounded, control-free source-compatible descriptor. No target is created/read.
    for (const [name, path, shown] of [["byte", "/" + "p".repeat(4095), 2], ["all", "/" + "界".repeat(4095), 0]] as const) {
      const members = Array.from({ length: 3 }, (_, index) => ({ ...member(`region-${index}`), summary: "Run failed.", status: "failed" as const,
        artifacts: Object.fromEntries(["a", "b", "c", "d"].map(key => [key, path])) }));
      for (const item of members) assert.equal(describeRunArtifactReferences(item.artifacts, item.state_dir).state, "available");
      const batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch({ ownerId: name, batchId: name, tempDir: root, members });
      const packet: CompletionYamlPacket = { batchId: name, records: members.slice(0, shown).map((item, index) => ({
        metadata: { index, run: item.run, state: "failed", result_state: "not captured", artifact_declarations: 4,
          references: { artifacts: { scope: "Declared paths; existence/production unproven.", declarations: Object.entries(item.artifacts).map(([name, path]) => ({ name, path })) } } }, parts: [] })),
        service: { omitted_results: 3 - shown, omitted_states: { failed: 3 - shown }, result_inventory: { ...batch.inventory_source! } } };
      assert.ok(batch.inventory_source);
      assert.equal(batch.members.length, 3); assert.equal(batch.text_budget, Math.floor(49152 / 3));
      const wire = candidateProofWire(packet);
      assert.equal(projectRunCompletionBatchPresentation(batch).content, wire);
      // Raw paths plus just two mandatory header fields exclude the next whole row.
      const rawRowBytes = 4 * Buffer.byteLength(path);
      assert.ok((shown + 1) * rawRowBytes + Buffer.byteLength("index: 0\nartifact_declarations: 4\n") > 49152);
      if (!shown) {
        assert.equal(packet.records.length, 0);
        assert.ok(wire.startsWith("_completion:\n"));
      }
      for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        assert.equal(transition({ ownerId: name, batchId: name, tempDir: root }), true);
        const recovered = readRunDeliveryJournal(root, name).completion_batch!;
        assert.equal(recovered.text_budget, batch.text_budget); assert.equal(projectRunCompletionBatchPresentation(recovered).content, wire);
      }
      console.log("candidate-q-region", JSON.stringify({ name, captured: 3, shown, bytes: Buffer.byteLength(wire), rawRowBytes, quota: batch.text_budget }));
    }
    const unsupported = { ...member("unsupported\ud800"), artifacts: undefined, summary: "Run completed." };
    assert.throws(() => deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch({ ownerId: "unsupported", tempDir: root, members: [unsupported] }), /unsupported_selected_data/u);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, "unsupported")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate q proof compares whole primary diagnostic inventory and run-file fields to controlled inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-q-refs-"));
  try {
    const raw = "\uFEFF---\r\nwhole😀\r\n", { artifacts: _unused, ...original } = member("whole");
    const base = { ...original, summary: "Run completed." };
    const item = { ...base, primary_text: primaryBinding(base, raw, ""), ...diagnosticBinding(base, "not a primary body", ""),
      artifact_inventory: { source: { path: join(base.state_dir, "evidence", `artifact-inventory-${"b".repeat(64)}.json`), run_instance_id: base.run_instance_id, sha256: "b".repeat(64) }, bytes_total: 500, declarations_total: 123 } };
    const locations = capturedLocations([item]), input = { ownerId: "whole", batchId: "whole", tempDir: root, members: [item], fileNavigation: locations };
    const before = JSON.stringify(input), batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input);
    const row = candidateProofPrimary(item, 0, raw, 49152);
    Object.assign(row.metadata, { artifact_declarations: 123 });
    Object.assign(row.metadata.references as object, {
      diagnostic_metadata: { scope: "Diagnostic metadata only; not primary output; admission privacy for recorded fields.", field: "error", recorded_fields_not_shown: ["failure_reason"],
        source: { ...item.result_diagnostics.source, bytes_total: 5000, fields: ["error", "failure_reason"] } },
      artifact_inventory: { scope: "Metadata only; target availability/production not asserted; bodies not read.", source: { ...item.artifact_inventory.source, bytes_total: 500, declarations_total: 123 } },
    });
    row.metadata.run_files = { run: item.run, run_instance_id: item.run_instance_id, locations: { ...locations[0]!.locations,
      files: locations[0]!.locations.files.map(({ mutable, ...file }) => ({ ...file, mutable })) } };
    // Metadata order is part of the canonical header: declarations precede references.
    const { references, run_files, ...fields } = row.metadata;
    row.metadata = { ...fields, references, run_files };
    const wire = candidateProofWire({ batchId: "whole", records: [row] });
    assert.equal(projectRunCompletionBatchPresentation(batch).content, wire);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(batch.members[0], item);
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      assert.equal(transition(input), true);
      const recovered = readRunDeliveryJournal(root, "whole").completion_batch!;
      assert.equal(recovered.text_budget, 49152); assert.equal(projectRunCompletionBatchPresentation(recovered).content, wire);
      assert.deepEqual(recovered.file_navigation, locations);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate r2 freezes admitted malformed metadata and unavailable bindings across source-less replay", async () => {
  const { describeRunArtifactReferences } = await import("../lib/runs-artifacts.ts");
  const { collectRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-r2-replay-"));
  try {
    const artifacts = { report: "/tmp/\ud800" };
    assert.equal(describeRunArtifactReferences(artifacts, root).state, "available");
    const collected = collectRunCompletionBatchMembers([{ run: "r2-metadata", runInstanceId: "generation-r2-metadata", stateDir: join(root, "metadata"),
      from: "running", to: "done", terminalAt: "2026-08-31T12:00:00.000Z", artifacts } as Parameters<typeof collectRunCompletionBatchMembers>[0][number]]);
    assert.equal(collected.length, 1);
    const raw = '\uFEFF---\r\nindex: forged\n```yaml\nnext:\n  tool: inspect\n😀\r\n';
    const primary = { ...collected[0]!, summary: "Run completed.", primary_text: primaryBinding(collected[0]!, raw, "") };
    const unavailable = { ...member("r2-unavailable"), state_dir: join(root, "unavailable"), artifacts: undefined, summary: "Run completed.",
      artifact_inventory: null, artifact_inventory_unavailable: "source_unavailable" };
    const sourcePath = primary.primary_text.output.source.path, oppositePath = join(unavailable.state_dir, "result.json");
    await mkdir(dirname(sourcePath), { recursive: true }); await mkdir(unavailable.state_dir, { recursive: true });
    await writeFile(sourcePath, raw); await writeFile(oppositePath, "unavailable controlled fixture");
    const input = { ownerId: "r2-replay", batchId: "r2-replay", tempDir: root, members: [primary, unavailable] };
    const batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input), expected = projectRunCompletionBatchPresentation(batch);
    assert.equal(batch.result_layout, "completion_yaml_files_v2"); assert.ok(Number.isInteger(batch.text_budget));
    assert.equal(batch.numbering, undefined); assert.equal(batch.members[1]!.artifact_inventory, null);
    assert.equal(batch.members[1]!.artifact_inventory_unavailable, "source_unavailable");
    const decoded = readCompletionYamlCarrier(expected.content);
    assert.equal(decoded.state, "available"); if (decoded.state !== "available") throw new Error("Candidate carrier unavailable");
    const row = decoded.packet.records.find(row => row.metadata.run === primary.run)!;
    assert.deepEqual(rootedEntries(row.metadata).find(entry => entry.role === "artifact").path, { utf16_code_units: "002f 0074 006d 0070 002f d800" });
    assert.deepEqual(row.parts, [{ body: raw }]); assert.equal(JSON.stringify(row.parts).includes("utf16_code_units"), false);
    assert.match(expected.content, /source_unavailable/u);
    await writeFile(sourcePath, "opposite live body must not renew retained text");
    await writeFile(oppositePath, JSON.stringify({ artifact_inventory: "opposite live availability; not an issued binding" }));
    artifacts.report = "/changed/live/path";
    const denied = new Set([sourcePath, oppositePath]), journalPath = getRunDeliveryJournalPath(root, input.ownerId);
    const readDescriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!, statDescriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync")!;
    const savedRead = fs.readFileSync, savedStat = fs.lstatSync;
    let sourceAttempts = 0, journalReads = 0;
    try {
      fs.readFileSync = ((path: any, ...args: any[]) => {
        if (denied.has(String(path))) { sourceAttempts++; throw new Error("Denied original controlled source"); }
        if (path === journalPath) journalReads++;
        return (savedRead as any)(path, ...args);
      }) as typeof fs.readFileSync;
      fs.lstatSync = ((path: any, ...args: any[]) => {
        if (denied.has(String(path))) { sourceAttempts++; throw new Error("Denied original controlled source stat"); }
        return (savedStat as any)(path, ...args);
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      for (const phase of ["pending", "queued", "presented"] as const) {
        if (phase === "queued") assert.equal(markRunCompletionBatchQueued(input), true);
        if (phase === "presented") assert.equal(markRunCompletionBatchPresented(input), true);
        const reopened = readRunDeliveryJournal(root, input.ownerId).completion_batch!;
        assert.equal(reopened.phase, phase); assert.equal(reopened.text_budget, batch.text_budget);
        assert.deepEqual(reopened.members, batch.members); assert.deepEqual(reopened.inventory_source, batch.inventory_source);
        assert.deepEqual(projectRunCompletionBatchPresentation(reopened), expected);
      }
      assert.ok(journalReads >= 3); assert.equal(sourceAttempts, 0);
    } finally {
      Object.defineProperty(fs, "readFileSync", readDescriptor); Object.defineProperty(fs, "lstatSync", statDescriptor); syncBuiltinESMExports();
    }
    const killDescriptor = Object.getOwnPropertyDescriptor(process, "kill")!, dateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Date")!;
    let pureEffects = 0;
    const refuse = () => { pureEffects++; throw new Error("Frozen projection cannot refresh IO/native/time"); };
    try {
      fs.readFileSync = refuse as typeof fs.readFileSync; fs.lstatSync = refuse as typeof fs.lstatSync;
      process.kill = refuse as typeof process.kill;
      globalThis.Date = new Proxy(Date, { construct: refuse, apply: refuse, get(target, key) { return key === "now" ? refuse : Reflect.get(target, key); } });
      syncBuiltinESMExports();
      assert.deepEqual(projectRunCompletionBatchPresentation(batch), expected);
      assert.equal(pureEffects, 0);
    } finally {
      Object.defineProperty(fs, "readFileSync", readDescriptor); Object.defineProperty(fs, "lstatSync", statDescriptor);
      Object.defineProperty(process, "kill", killDescriptor); Object.defineProperty(globalThis, "Date", dateDescriptor); syncBuiltinESMExports();
    }
    console.log("candidate-r2-replay", JSON.stringify({ members: 2, phases: 3, journalReads, sourceAttempts, pureEffects, quota: batch.text_budget,
      bytes: Buffer.byteLength(expected.content), controlledSourcesOnly: true }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Candidate r2 reached inventory postwrite guards refuse parent inode nonregular and wrong size", async () => {
  for (const fault of ["parent-inode", "parent-inode-unsafe-integer", "nonregular", "wrong-size"] as const) {
    const parentFault = fault.startsWith("parent-inode");
    const root = await mkdtemp(join(tmpdir(), "pi-actors-r2-physical-"));
    const members = Array.from({ length: 65 }, (_, index) => ({ ...member(`r2-${index}`), artifacts: undefined, summary: "Run completed." }));
    const input = { ownerId: "r2-physical", batchId: "r2-physical", tempDir: root, members, now: new Date("2026-08-31T12:00:00.000Z") };
    const inventory = `${JSON.stringify({ schema: "run-completion-inventory-v1", batch_id: input.batchId, created_at: input.now.toISOString(),
      scope: "captured_completion_members", members_total: 65, artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
      members: members.map(m => ({ run: m.run, run_instance_id: m.run_instance_id, status: m.status, terminal_at: m.terminal_at })) }, null, 2)}\n`;
    const journalPath = getRunDeliveryJournalPath(root, input.ownerId);
    const sourcePath = join(dirname(journalPath), `inventory-${createHash("sha256").update(inventory).digest("hex")}.json`);
    const writeDescriptor = Object.getOwnPropertyDescriptor(fs, "writeFileSync")!, statDescriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync")!;
    const savedWrite = fs.writeFileSync, savedStat = fs.lstatSync;
    let writes = 0, interceptions = 0;
    try {
      fs.writeFileSync = ((path: any, data: any, options: any) => {
        if (path !== sourcePath) return savedWrite(path, data, options);
        assert.equal(data, inventory); assert.equal(options.flag, "wx");
        const result = savedWrite(path, data, options);
        assert.equal(fs.readFileSync(path, "utf8"), inventory); writes++; return result;
      }) as typeof fs.writeFileSync;
      fs.lstatSync = ((path: any, ...args: any[]) => {
        const actual = (savedStat as any)(path, ...args);
        // Controlled numeric metadata, not an observed native inode or replacement.
        const stat = fault === "parent-inode-unsafe-integer" && path === dirname(sourcePath)
          ? Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, { ino: 2 ** 60 }) : actual;
        if (writes === 1 && ((parentFault && path === dirname(sourcePath)) || (!parentFault && path === sourcePath))) {
          interceptions++;
          if (fault === "parent-inode-unsafe-integer") assert.equal(stat.ino + 1, stat.ino);
          const changed = parentFault ? { ino: stat.ino === 0 ? 1 : 0 } : fault === "nonregular" ? { isFile: () => false } : { size: stat.size + 1 };
          if ("ino" in changed) assert.notEqual(changed.ino, stat.ino);
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changed);
        }
        return stat;
      }) as typeof fs.lstatSync;
      syncBuiltinESMExports();
      assert.throws(() => deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input), /Completion inventory source binding changed during retention/u);
      assert.equal(writes, 1); assert.ok(interceptions > 0);
      assert.equal(fs.readFileSync(sourcePath, "utf8"), inventory); assert.equal(fs.existsSync(journalPath), false);
      assert.equal(readRunDeliveryJournal(root, input.ownerId).completion_batch, undefined);
      console.log("candidate-r2-physical", JSON.stringify({ fault, writes, interceptions, bytes: Buffer.byteLength(inventory), journalAbsent: true, orphanRetained: true }));
    } finally {
      Object.defineProperty(fs, "writeFileSync", writeDescriptor); Object.defineProperty(fs, "lstatSync", statDescriptor); syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Candidate capture is a fresh closed journal layout, not a prototype overlay", async () => {
  assert.equal(typeof deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch, "function");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-"));
  try {
    for (const count of [1, 2, 65, 256]) {
      const ownerId = "candidate-" + count, input = { ownerId, tempDir: root, batchId: ownerId };
      const raw = '\uFEFF---\r\nBatch: `forged`\n```unfinished😀\r\n';
      const members = Array.from({ length: count }, (_, index) => {
        const base = { ...member("candidate" + index), summary: "Run completed.", artifacts: undefined };
        return { ...base, primary_text: primaryBinding(base, raw, ""),
          completion_text: { text: raw, shown_bytes: { start: 0, end: Buffer.byteLength(raw) } } };
      });
      const batch = deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch({ ...input, members });
      assert.equal(batch.result_layout, "completion_yaml_files_v2");
      assert.ok(Number.isInteger(batch.text_budget));
      assert.equal(batch.members.length, count);
      const projected = projectRunCompletionBatchPresentation(batch);
      assert.equal(projected.presentation?.format, "completion_yaml_core_v1");
      assert.deepEqual(Object.keys(projected.presentation!).sort(), ["content_sha256", "format"]);
      assert.ok(Buffer.byteLength(projected.content) <= 49152);
      assert.equal(projected.content.includes("<!-- pi-actors:"), false);
      const decoded = readCompletionYamlCarrier(projected.content);
      assert.equal(decoded.state, "available"); if (decoded.state !== "available") continue;
      assert.equal(decoded.packet.batchId, ownerId);
      assert.equal(decoded.packet.records.length, Math.min(count, 64));
      assert.deepEqual(decoded.packet.records.map(row => row.metadata.index), count === 1 ? [undefined] : Array.from({ length: Math.min(count, 64) }, (_, i) => i));
      assert.deepEqual(decoded.packet.records.map(row => row.parts.filter(part => "body" in part).map(part => "body" in part ? part.body : "")), Array.from({ length: Math.min(count, 64) }, () => [raw]));
      assert.equal(Boolean(batch.inventory_source), count > 64);
      assert.equal(deliveryYamlPrototype.projectRunCompletionYamlPrototype(batch).state, "unavailable");
      if (count === 1) {
        const common = { session_id: ownerId, stream_id: '01234567-89ab-4cde-8fab-0123456789ab', member_order: [0] };
        const path = getRunDeliveryJournalPath(root, ownerId), original = fs.readFileSync(path, 'utf8');
        for (const numbering of [{ ...common, kind: 'stream', first_index: 41 }, { ...common, kind: 'unavailable', reason: 'counter_unavailable' }, undefined]) {
          const mixed = { ...batch, numbering };
          assert.throws(() => projectRunCompletionBatchPresentation(mixed as any), /Completion numbering/u);
          const journal = JSON.parse(original);
          journal.completion_batch = mixed;
          journal.completion_stream = { active: { stream_id: common.stream_id, counter: { state: 'available', next_index: 42 } } };
          fs.writeFileSync(path, JSON.stringify(journal));
          if (numbering !== undefined) assert.throws(() => readRunDeliveryJournal(root, ownerId), /Completion numbering/u);
          fs.writeFileSync(path, original);
        }
      }
      const snapshot = JSON.stringify(batch);
      for (const phase of ["pending", "queued", "presented"] as const) {
        if (phase === "queued") markRunCompletionBatchQueued(input);
        if (phase === "presented") markRunCompletionBatchPresented(input);
        const reopened = readRunDeliveryJournal(root, ownerId).completion_batch!;
        assert.equal(reopened.phase, phase);
        assert.deepEqual(projectRunCompletionBatchPresentation(reopened), projected);
        assert.equal(reopened.text_budget, batch.text_budget);
        assert.deepEqual(reopened.members, batch.members);
      }
      assert.equal(JSON.stringify(batch), snapshot);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Fresh rooted headers group native and external paths without guessing missing bases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-rooted-files-"));
  try {
    const base = { ...member("rooted"), summary: "Run completed.", artifacts: undefined };
    const raw = "\uFEFF## Итог\r\n\r\n```md\n---\nfiles: authored content\nEND";
    const artifacts = { local: join(base.state_dir, "artifacts", "report.md"), external: "/outside/reports/report.md",
      windows: "C:\\reports\\report.md", unc: "\\\\server\\share\\reports\\report.md" };
    const unresolved = { relative: "report.md", dotted: "/outside/link/../report.md", drive_relative: "C:report.md", unc_incomplete: "\\\\server" };
    const item = { ...base, artifacts, primary_text: primaryBinding(base, raw, "") };
    const before = JSON.stringify(item);
    const batch = admitRunCompletionBatch({ ownerId: "rooted", tempDir: root, members: [item], fileNavigation: capturedLocations([item]) });
    assert.equal(batch.result_layout, "completion_yaml_files_v2");
    const projected = projectRunCompletionBatchPresentation(batch), metadata = coreRows(projected.content)[0].metadata;
    const entries = rootedEntries(metadata), groups = metadata.files.groups;
    assert.equal(groups.filter((group: any) => group.root === base.state_dir).length, 1);
    assert.equal(entries.find(entry => entry.name === "local").path, join("artifacts", "report.md"));
    for (const [name, expectedRoot] of [["external", "/outside/reports"], ["windows", "C:\\reports"], ["unc", "\\\\server\\share\\reports"]] as const) {
      const entry = entries.find(entry => entry.name === name); assert.equal(entry.root, expectedRoot); assert.equal(entry.path, "report.md");
      assert.equal(entry.state, "declared"); assert.match(entry.scope, /unproven/);
    }
    const unresolvedBatch = admitRunCompletionBatch({ ownerId: "unresolved", tempDir: root, members: [{ ...item, artifacts: unresolved }] });
    const unresolvedEntries = rootedEntries(coreRows(projectRunCompletionBatchPresentation(unresolvedBatch).content)[0].metadata);
    for (const name of ["relative", "dotted", "drive_relative", "unc_incomplete"] as const) {
      const entry = unresolvedEntries.find(entry => entry.name === name);
      assert.equal(entry.root, null); assert.equal(entry.path, unresolved[name]); assert.equal(entry.path_basis, "as_recorded");
      assert.equal(entry.base_unavailable, true);
    }
    const first = metadata.files.read_first, firstGroup = groups[first.group], entry = firstGroup.entries[first.entry];
    assert.equal(entry.role, "primary"); assert.equal(entry.purpose, "Full result text");
    assert.equal(join(firstGroup.root, entry.path), item.primary_text.output.source.path);
    assert.equal(entry.source.sha256, item.primary_text.output.source.sha256);
    assert.deepEqual(rootedNavigation(metadata).locations, batch.file_navigation![0].locations);
    const view = readRunCompletionPresentation(projected.content, projected.presentation)!;
    assert.equal(view.segments!.some(segment => segment.kind === "service"), false);
    assert.deepEqual(view.segments!.filter(segment => segment.kind === "body").map(segment => segment.text), [raw]);
    assert.ok(view.text.endsWith(raw)); assert.ok(projected.content.endsWith(raw));
    assert.ok(view.segments![0].text.includes("files:")); assert.ok(!view.text.includes("header_layout"));
    assert.equal(JSON.stringify(item), before);
    assert.deepEqual(coreRows(projected.content)[0].parts, [{ body: raw }]);
    markRunCompletionBatchQueued({ ownerId: "rooted", tempDir: root, batchId: batch.batch_id });
    assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "rooted").completion_batch!), projected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Rooted completion omissions and inventory stay in the first header, never after Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-rooted-omissions-"));
  try {
    const members = Array.from({ length: 65 }, (_, i) => {
      const base = { ...member("r" + String(i).padStart(2, "0")), summary: "Run completed.", artifacts: undefined };
      return { ...base, primary_text: primaryBinding(base, "result", "") };
    });
    const batch = admitRunCompletionBatch({ ownerId: "omissions", tempDir: root, members });
    const projected = projectRunCompletionBatchPresentation(batch), view = readRunCompletionPresentation(projected.content, projected.presentation)!;
    const rows = coreRows(projected.content);
    assert.equal(rows.length, 64); assert.equal(rows[0].metadata._completion.service.omitted_results, 1);
    assert.equal(view.segments!.some(segment => segment.kind === "service"), false);
    assert.match(view.segments![0].text, /delivery:\n  omitted_results: 1/);
    const inventory = rows[0].metadata._completion.service.result_inventory;
    assert.equal(join(inventory.root, inventory.path), batch.inventory_source!.path);
    assert.equal(inventory.sha256, batch.inventory_source!.sha256);
    assert.ok(view.text.endsWith("result")); assert.ok(projected.content.endsWith("result"));
    assert.ok(Buffer.byteLength(projected.content) <= 49152);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained core-v1 and rooted-v1 snapshots keep their exact indices, references, body and presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retained-core-"));
  try {
    const base = { ...member("old"), summary: "Run completed.", artifacts: undefined };
    const item = { ...base, primary_text: primaryBinding(base, "original", "") };
    const legacy = { batch_id: "old-core", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "completion_yaml_core_v1" as const, text_budget: 49152, members: [item] };
    const row = candidateProofPrimary(item, 0, "original", 49152);
    const encoded = encodeCompletionYamlCarrier({ batchId: legacy.batch_id, records: [row] });
    assert.equal(encoded.state, "available"); if (encoded.state !== "available") return;
    const before = projectRunCompletionBatchPresentation(legacy);
    assert.equal(before.content, encoded.text);
    const view = readRunCompletionPresentation(before.content, before.presentation)!;
    assert.equal(view.text.includes("references:"), false); assert.ok(view.text.endsWith("original"));
    const fresh = admitRunCompletionBatch({ ownerId: "new", tempDir: root, members: [item] });
    assert.equal(fresh.result_layout, "completion_yaml_files_v2");
    const freshProjection = projectRunCompletionBatchPresentation(fresh);
    assert.equal(Object.hasOwn(coreRows(freshProjection.content)[0].metadata, "index"), false);
    assert.deepEqual(projectRunCompletionBatchPresentation(legacy), before);
    assert.equal(coreRows(before.content)[0].metadata.references.primary.source.path, item.primary_text.output.source.path);
    assert.equal(coreRows(before.content)[0].metadata.files, undefined);
    const journalPath = getRunDeliveryJournalPath(root, "new"), journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    for (const result_layout of ["completion_yaml_core_v1", "completion_yaml_files_v1"] as const) {
      const saved = { ...legacy, result_layout }, expected = projectRunCompletionBatchPresentation(saved);
      const expectedWire: string = result_layout === "completion_yaml_core_v1" ? encoded.text : candidateProofWire({
        batchId: legacy.batch_id, records: [row], service: { header_layout: "rooted_files_v1" },
      });
      assert.equal(expected.content, expectedWire);
      assert.equal(coreRows(expected.content)[0].metadata.index, 0);
      assert.ok(readRunCompletionPresentation(expected.content, expected.presentation)!.segments!.some(segment => segment.kind === "header" && /^index: 0$/mu.test(segment.text)));
      journal.completion_batch = saved;
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        transition?.({ batchId: saved.batch_id, ownerId: "new", tempDir: root });
        assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "new").completion_batch!), expected);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Core YAML presentation derives typed segments only from strict carrier and minimal own hint", () => {
  const body = '\uFEFF---\r\nreferences: BODY😀\n<!-- next: authored -->\n```';
  const packet: CompletionYamlPacket = { batchId: "technical-id", records: [
    { metadata: { index: "?", run: "typed", state: "done", kind: "primary", references: { child: "HIDE_REF" }, run_files: { nested: { child: "HIDE_PATH" } }, fact: "keep" }, parts: [{ body }, { marker: "\n" }, { marker: "[2 characters omitted]" }] },
    { metadata: { index: 41, run: "peer", state: "failed" }, parts: [{ body: "**peer**" }] }],
    service: { omitted_results: 2, omitted_states: { failed: 1 }, inventory_warning: "warning", result_inventory: { path: "inventory" }, numbering_unavailable: "counter_unavailable", other: { nested: true } } };
  const encoded = encodeCompletionYamlCarrier(packet);
  assert.equal(encoded.state, "available"); if (encoded.state !== "available") return;
  const content = encoded.text, before = JSON.stringify(packet);
  const hint = { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(content).digest("hex") };
  const view = deliveryYamlPrototype.readRunCompletionPresentation(content, hint);
  assert.equal(view?.compact, true);
  assert.equal(view?.text.includes("HIDE_REF"), false);
  assert.equal(view?.text.includes("HIDE_PATH"), false);
  assert.ok(view?.text.includes('index: "?"'));
  assert.ok(view?.text.includes("other:"));
  assert.ok(view?.text.includes("result_inventory:"));
  assert.ok(view?.text.includes(body));
  assert.deepEqual(view?.segments?.filter(segment => segment.kind === "body").map(segment => segment.text), [body, "**peer**"]);
  assert.ok(Object.isFrozen(view?.segments)); assert.ok(view?.segments?.every(Object.isFrozen));
  assert.equal(JSON.stringify(packet), before);
  let hooks = 0;
  const accessor = Object.defineProperty({ ...hint }, "content_sha256", { get() { hooks++; throw new Error("hook"); } });
  const proxy = new Proxy(hint, { getOwnPropertyDescriptor() { hooks++; throw new Error("proxy"); } });
  const formatAccessor = Object.defineProperty({ ...hint }, "format", { get() { hooks++; throw new Error("format hook"); } });
  const serializer = { ...hint, toJSON() { hooks++; throw new Error("serialization hook"); } };
  const hidden = Object.defineProperty({ ...hint }, "extra", { value: 1 });
  for (const invalid of [undefined, {}, { ...hint, content_sha256: "wrong" }, { ...hint, format: "wrong" }, { ...hint, extra: 1 }, { ...hint, [Symbol("extra")]: 1 }, hidden, serializer, formatAccessor, accessor, proxy, () => hint, [hint], Object.assign(new Array(2), { format: hint.format })]) {
    const fallback = deliveryYamlPrototype.readRunCompletionPresentation(content, invalid);
    assert.equal(fallback?.text, content); assert.equal(fallback?.compact, false);
  }
  assert.equal(hooks, 0);
  for (const malformed of [content + "broken", "---\nnot a carrier\n---\nbody", ""]) {
    assert.deepEqual(deliveryYamlPrototype.readRunCompletionPresentation(malformed, hint), { text: malformed, compact: false, records: true, yaml: true });
  }
  assert.equal(deliveryYamlPrototype.readRunCompletionPresentation("---\nordinary prose", undefined), undefined);
});

test("Core YAML presentation preserves absent, empty and marker-only bodies and service-only facts", () => {
  for (const parts of [[], [{ body: "" }], [{ marker: "warning" }], [{ body: " \n" }]]) {
    const encoded = encodeCompletionYamlCarrier({ batchId: "id", records: [{ metadata: { index: 0, run: "r", state: "done" }, parts }] });
    assert.equal(encoded.state, "available"); if (encoded.state !== "available") continue;
    const view = deliveryYamlPrototype.readRunCompletionPresentation(encoded.text, { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(encoded.text).digest("hex") });
    assert.equal(view?.compact, true);
    assert.equal(view?.text.startsWith("---\n"), parts.length > 0);
    assert.equal(view?.text.includes("_completion"), false);
    assert.deepEqual(view?.segments?.filter(segment => segment.kind === "body" || segment.kind === "marker").map(segment => ({ [segment.kind]: segment.text })), parts);
  }
  const encoded = encodeCompletionYamlCarrier({ batchId: "id", records: [], service: { omitted_results: 9, omitted_states: { killed: 2 }, inventory_warning: "none" } });
  assert.equal(encoded.state, "available"); if (encoded.state !== "available") return;
  const view = deliveryYamlPrototype.readRunCompletionPresentation(encoded.text, { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(encoded.text).digest("hex") });
  assert.equal(view?.compact, true); assert.match(view!.text, /^omitted_results: 9\n/u);
  assert.doesNotMatch(view!.text, /index:|---|_completion|batch_id/u);
});
import * as deliveryYamlPrototype from "../lib/run-delivery.ts";
import { encodeCompletionYamlCarrier, readCompletionYamlCarrier, type CompletionYamlPacket } from "../lib/run-delivery.ts";
import { mutationLockPath } from "../lib/file-state.ts";
import {
  admitRunCompletionBatch,
  captureRunCompletionStreamBatch,
  admitRunSteerEnvelope,
  finalizeRunCompletionBatch,
  finalizeRunSteer,
  formatRunCompletionBatchMessage,
  getRunDeliveryJournalPath,
  getRunSteerDeliveryId,
  markRunCompletionBatchPresented,
  markRunCompletionBatchQueued,
  markRunSteerPresented,
  markRunSteerQueued,
  readRunDeliveryJournal,
  readRunCompletionStreamStatus,
  requestRunCompletionStream,
  recordRunCompletionBatchDeliveryFailure,
  recordRunSteerDeliveryFailure,
  resetRunCompletionBatchPending,
  resetRunSteerPending,
  type RunCompletionBatchMember,
  orderRunCompletionMembers,
  projectRunCompletionBatchPresentation,
  projectRunCompletionIndexRange,
  readRunCompletionPresentation,
  readRunCompletionRecordMarker,
} from "../lib/run-delivery.ts";

test("completion stream index ranges cover the full capture or issue no numeric indices", () => {
  const limit = Number.MAX_SAFE_INTEGER, exactLimit = BigInt(limit);
  for (let count = 1; count <= Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS; count++) {
    for (const next of new Set([0, 1, limit - count, limit - count + 1, limit - 1, limit])) {
      const range = projectRunCompletionIndexRange(next, count);
      assert.ok(Object.isFrozen(range));
      assert.deepEqual(JSON.parse(JSON.stringify(range)), range);
      if (BigInt(next) + BigInt(count) > exactLimit) {
        assert.deepEqual(range, { state: "unavailable", reason: "range_unavailable", next_index: next });
        assert.equal("indices" in range, false);
        continue;
      }
      assert.equal(range.state, "available");
      if (range.state !== "available") throw new Error("Expected a complete numeric range");
      assert.ok(Object.isFrozen(range.indices));
      assert.equal(range.indices.length, count);
      assert.equal(BigInt(range.next_index), BigInt(next) + BigInt(count));
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const index: number = range.indices[ordinal]!;
        assert.ok(Number.isSafeInteger(index));
        assert.ok(index >= 0 && index <= limit - 1);
        assert.equal(BigInt(index), BigInt(next) + BigInt(ordinal));
      }
    }
  }
  const full = projectRunCompletionIndexRange(0, Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS);
  assert.equal(full.state, "available");
  if (full.state === "available") {
    assert.equal(full.indices[Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS], Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS);
    assert.equal(full.indices.at(-1), Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS - 1);
  }
  assert.deepEqual(projectRunCompletionIndexRange(-0, 1), { state: "available", next_index: 1, indices: [0] });
});

test("completion stream range projection refuses invalid counters and capture sizes without coercion", () => {
  let coercions = 0;
  const opaque = { valueOf() { coercions++; throw new Error("Must not coerce"); }, toString() { coercions++; throw new Error("Must not coerce"); } };
  for (const value of [undefined, null, "0", false, {}, [], new Number(0), opaque, 0n, NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => projectRunCompletionIndexRange(value as number, 1), /Completion stream counter is invalid/u);
  }
  for (const value of [undefined, null, "1", true, {}, [], new Number(1), opaque, 1n, NaN, Infinity, -Infinity, -1, 0, 0.5, Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS + 1]) {
    assert.throws(() => projectRunCompletionIndexRange(0, value as number), /Completion stream member count is invalid/u);
  }
  assert.equal(coercions, 0);
});

test("Completion stream intent retains one owner-scoped target without activation or packet restyling", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-intent-"));
  const ownerId = "stream-owner", input = { tempDir: root, ownerId };
  const path = getRunDeliveryJournalPath(root, ownerId);
  try {
    assert.deepEqual(readRunCompletionStreamStatus(root, ownerId), { state: "unavailable", reason: "stream_state_unavailable" });
    assert.equal(fs.existsSync(path), false);
    assert.throws(() => requestRunCompletionStream(input), /requires an existing delivery journal/u);
    assert.equal(fs.existsSync(path), false);
    const batch = admitRunCompletionBatch({ ...input, members: [member("stream-blocker")] });
    const original = projectRunCompletionBatchPresentation(batch);
    const beforeStatus = fs.readFileSync(path);
    assert.deepEqual(readRunCompletionStreamStatus(root, ownerId), { state: "unavailable", reason: "stream_state_unavailable" });
    assert.deepEqual(fs.readFileSync(path), beforeStatus);
    const target = requestRunCompletionStream(input);
    assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("blocked-by-old-local")] }), /active completion batch/u);
    assert.ok(Object.isFrozen(target));
    assert.match(target.pending_stream_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const saved = fs.readFileSync(path), rename = fs.renameSync;
    fs.renameSync = ((from, to) => { assert.notEqual(String(to), path, "A retained target must not rewrite its journal"); return rename(from, to); }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    try { assert.deepEqual(requestRunCompletionStream(input), target); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(path), saved);
    const status = readRunCompletionStreamStatus(root, ownerId);
    assert.ok(Object.isFrozen(status));
    assert.deepEqual(status, { state: "pending", session_id: ownerId, pending_stream_id: target.pending_stream_id, blocking_batch_id: batch.batch_id });
    assert.deepEqual(readRunDeliveryJournal(root, ownerId).completion_batch, batch);
    assert.deepEqual(readRunCompletionStreamStatus(root, "other-owner"), { state: "unavailable", reason: "stream_state_unavailable" });
    const other = admitRunCompletionBatch({ tempDir: root, ownerId: "other-owner", members: [member("other-stream")] });
    assert.match(formatRunCompletionBatchMessage(other), /^---\nrun:/u);
    assert.equal(Object.hasOwn(coreRows(formatRunCompletionBatchMessage(other))[0].metadata, "index"), false);
    assert.equal(readRunDeliveryJournal(root, "other-owner").completion_stream, undefined);
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      assert.equal(transition({ ...input, batchId: batch.batch_id }), true);
      const journal = readRunDeliveryJournal(root, ownerId);
      assert.deepEqual(journal.completion_stream, target);
      assert.deepEqual(projectRunCompletionBatchPresentation(journal.completion_batch!), original);
    }
    assert.equal(finalizeRunCompletionBatch({ ...input, batchId: batch.batch_id }), true);
    assert.deepEqual(readRunCompletionStreamStatus(root, ownerId), { state: "pending", session_id: ownerId, pending_stream_id: target.pending_stream_id });
    const finalized = fs.readFileSync(path);
    assert.throws(() => admitRunCompletionBatch({ ...input, members: [member("must-not-be-local")] }), /numbered kernel path/u);
    assert.deepEqual(fs.readFileSync(path), finalized);
    // Manufacture a full retained receipt tail only in this isolated fixture, then rotate it through the real writer.
    const journal = JSON.parse(finalized.toString());
    journal.receipts = Array.from({ length: Limits.RUN_DELIVERY_RECEIPT_LIMIT }, (_, i) =>
      ({ delivery_id: "retained-" + i, kind: "completion_batch", presented_at: "2026-08-31T12:00:00.000Z" }));
    fs.writeFileSync(path, JSON.stringify(journal));
    const steer = admitRunSteerEnvelope({ ...input, eventId: "intent-retention", kind: "checkpoint", level: "info", occurredAt: "2026-08-31T12:00:00.000Z",
      content: "Retained intent", run: "stream-blocker", runInstanceId: "generation-stream-blocker", stateDir: fixtureStateDir("stream-blocker") });
    assert.ok(steer);
    assert.equal(markRunSteerQueued({ ...input, steerId: steer.steer_id }), true);
    assert.equal(markRunSteerPresented({ ...input, steerId: steer.steer_id }), true);
    assert.equal(finalizeRunSteer({ ...input, steerId: steer.steer_id }), true);
    const rotated = readRunDeliveryJournal(root, ownerId);
    assert.equal(rotated.receipts.length, Limits.RUN_DELIVERY_RECEIPT_LIMIT);
    assert.equal(rotated.receipts[0]!.delivery_id, "retained-1");
    assert.deepEqual(rotated.completion_stream, target);
    fs.unlinkSync(path);
    assert.deepEqual(readRunCompletionStreamStatus(root, ownerId), { state: "unavailable", reason: "stream_state_unavailable" });
    assert.throws(() => requestRunCompletionStream(input), /requires an existing delivery journal/u);
    assert.equal(fs.existsSync(path), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Completion stream intent rejects malformed and accessor state without repair or inherited adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-integrity-"));
  const ownerId = "stream-integrity", input = { tempDir: root, ownerId };
  const path = getRunDeliveryJournalPath(root, ownerId);
  try {
    admitRunCompletionBatch({ ...input, members: [member("integrity")] });
    const original = fs.readFileSync(path, "utf8"), base = JSON.parse(original);
    const valid = "01234567-89ab-4cde-8fab-0123456789ab";
    for (const value of [null, [], {}, "", { pending_stream_id: "" }, { pending_stream_id: valid.toUpperCase() },
      { pending_stream_id: valid, active: true }, { pending_stream_id: "not-a-stream" }]) {
      const bytes = JSON.stringify({ ...base, completion_stream: value });
      fs.writeFileSync(path, bytes);
      assert.throws(() => readRunCompletionStreamStatus(root, ownerId), /Completion stream intent/u);
      assert.throws(() => requestRunCompletionStream(input), /Completion stream intent/u);
      assert.equal(fs.readFileSync(path, "utf8"), bytes);
    }
    fs.writeFileSync(path, JSON.stringify({ ...base, owner_id: "foreign", completion_stream: { pending_stream_id: valid } }));
    assert.throws(() => requestRunCompletionStream(input), /owner does not match/u);
    fs.writeFileSync(path, original);
    const parse = JSON.parse;
    let getters = 0;
    try {
      for (const shape of ["root-accessor", "nested-accessor", "inherited"] as const) {
        JSON.parse = ((text, reviver) => {
          const value = parse(text, reviver);
          if (value?.schema === "run-delivery-v1" && value.owner_id === ownerId) {
            const fault = () => { getters++; throw new Error("Must not invoke stream accessors"); };
            if (shape === "root-accessor") Object.defineProperty(value, "completion_stream", { enumerable: true, get: fault });
            else if (shape === "nested-accessor") {
              value.completion_stream = Object.defineProperty({}, "pending_stream_id", { enumerable: true, get: fault });
            } else Object.setPrototypeOf(value, { completion_stream: { pending_stream_id: valid } });
          }
          return value;
        }) as typeof JSON.parse;
        if (shape === "inherited") {
          assert.deepEqual(readRunCompletionStreamStatus(root, ownerId), { state: "unavailable", reason: "stream_state_unavailable" });
          assert.equal(readRunDeliveryJournal(root, ownerId).completion_stream, undefined);
        } else assert.throws(() => readRunCompletionStreamStatus(root, ownerId), /Completion stream intent/u);
      }
    } finally { JSON.parse = parse; }
    assert.equal(getters, 0);
    assert.equal(fs.readFileSync(path, "utf8"), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Completion stream intent preserves exact failures before or after atomic replacement and reconciles saved targets", async () => {
  for (const phase of ["before", "after"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-fault-"));
    const input = { tempDir: root, ownerId: "stream-fault" }, path = getRunDeliveryJournalPath(root, input.ownerId);
    const rename = fs.renameSync, failure = new Error("Original " + phase + " replacement failure");
    try {
      const batch = admitRunCompletionBatch({ ...input, members: [member("fault")] });
      const projection = projectRunCompletionBatchPresentation(batch), bytes = fs.readFileSync(path);
      let replacements = 0;
      fs.renameSync = ((from, to) => {
        if (String(to) !== path) return rename(from, to);
        replacements++;
        if (phase === "after") rename(from, to);
        throw failure;
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      try { assert.throws(() => requestRunCompletionStream(input), error => error === failure); }
      finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      assert.equal(replacements, 1);
      const recovered = readRunDeliveryJournal(root, input.ownerId);
      assert.deepEqual(projectRunCompletionBatchPresentation(recovered.completion_batch!), projection);
      if (phase === "before") {
        assert.equal(recovered.completion_stream, undefined);
        assert.deepEqual(fs.readFileSync(path), bytes);
      } else {
        const retained = recovered.completion_stream!;
        assert.ok(retained);
        assert.deepEqual(requestRunCompletionStream(input), retained);
        assert.equal(readRunCompletionStreamStatus(root, input.ownerId).state, "pending");
      }
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
  }
});

test("Numbered kernel capture atomically fixes all member indices including omitted zero and receipt-independent retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-allocation-"));
  try {
    const missing = { tempDir: root, ownerId: "missing-stream" };
    assert.throws(() => captureRunCompletionStreamBatch({ ...missing, members: [member("missing")] }), /requires an existing delivery journal/u);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, missing.ownerId)), false);
    for (const [count, hiddenZero] of [[1, false], [65, false], [256, false], [1, true]] as const) {
      const input = { tempDir: root, ownerId: hiddenZero ? "s".repeat(4096) : "allocation-" + count };
      const legacy = admitRunCompletionBatch({ ...input, members: [member("before-stream")] });
      finishCapturedFixture(input, legacy);
      assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("no-intent")] }), /requires retained stream state/u);
      const target = requestRunCompletionStream(input), path = getRunDeliveryJournalPath(root, input.ownerId);
      const pending = fs.readFileSync(path), rename = fs.renameSync;
      let replacements = 0;
      fs.renameSync = ((from, to) => {
        if (String(to) === path) {
          replacements++;
          assert.deepEqual(fs.readFileSync(path), pending);
          const candidate = JSON.parse(fs.readFileSync(String(from), "utf8"));
          assert.equal(candidate.completion_stream.pending_stream_id, undefined);
          assert.equal(candidate.completion_stream.active.stream_id, target.pending_stream_id);
          assert.deepEqual(candidate.completion_stream.active.counter, { state: "available", next_index: count });
          assert.equal(candidate.completion_batch.numbering.first_index, 0);
          assert.equal(candidate.completion_batch.numbering.member_order.length, count);
        }
        return rename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      let batch: ReturnType<typeof captureRunCompletionStreamBatch>;
      try {
        batch = captureRunCompletionStreamBatch({ ...input, members: Array.from({ length: count }, (_, i) =>
          ({ ...member("n" + i), artifacts: undefined, summary: "Run completed.", ...(hiddenZero ? { artifacts: Object.fromEntries(Array.from({ length: 4 }, (_, j) => [String(j), "/" + "界".repeat(4090)])) } : {}) })) });
      } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
      assert.equal(replacements, 1);
      const journal = readRunDeliveryJournal(root, input.ownerId), active = journal.completion_stream!.active!;
      assert.ok(Object.isFrozen(active) && Object.isFrozen(active.counter));
      assert.deepEqual(journal.completion_batch, batch);
      assert.equal(batch.numbering!.kind, "stream");
      assert.deepEqual(batch.numbering!.member_order, Array.from({ length: count }, (_, i) => i));
      assert.equal(batch.numbering!.session_id, input.ownerId);
      const projection = projectRunCompletionBatchPresentation(batch), shown = (projection.content.match(/^index: \d+$/gm) ?? []).length;
      assert.ok(projection.content.startsWith("— Новый поток " + target.pending_stream_id + " · отсчёт с #0 —\n"));
      assert.ok(Buffer.byteLength(projection.content) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
      assert.ok(shown <= Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS);
      if (shown < count) {
        assert.ok(projection.content.includes("- omitted_results: " + (count - shown)));
        const source = fs.readFileSync(batch.inventory_source!.path, "utf8"), inventory = JSON.parse(source);
        assert.equal(createHash("sha256").update(source).digest("hex"), batch.inventory_source!.sha256);
        assert.equal(inventory.members.length, count);
        assert.deepEqual(inventory.numbering, batch.numbering);
      }
      if (hiddenZero) assert.equal(shown, 0);
      assert.equal(readRunCompletionRecordMarker(projection.content)!.batchId, batch.batch_id);
      assert.equal(readRunCompletionPresentation(projection.content, projection.presentation)!.compact, true);
      const beforeStatus = fs.readFileSync(path);
      assert.deepEqual(readRunCompletionStreamStatus(root, input.ownerId), {
        state: "active", session_id: input.ownerId, active, blocking_batch_id: batch.batch_id,
      });
      assert.deepEqual(fs.readFileSync(path), beforeStatus);
      finishCapturedFixture(input, batch);
      assert.throws(() => admitRunCompletionBatch({ ...input, members: [member("not-local")] }), /numbered kernel path/u);
      // Manufacture only a receipt tail in this isolated fixture; rotate it through the real urgent writer.
      const retained = JSON.parse(fs.readFileSync(path, "utf8"));
      retained.receipts = Array.from({ length: Limits.RUN_DELIVERY_RECEIPT_LIMIT }, (_, i) =>
        ({ delivery_id: "old-" + i, kind: "completion_batch", presented_at: "2026-08-31T12:00:00.000Z" }));
      fs.writeFileSync(path, JSON.stringify(retained));
      const steer = admitRunSteerEnvelope({ ...input, eventId: "active-retention", kind: "checkpoint", level: "info",
        occurredAt: "2026-08-31T12:00:00.000Z", content: "Unnumbered urgent content", run: "n0", runInstanceId: "generation-n0", stateDir: fixtureStateDir("n0") })!;
      assert.equal(steer.content, "Unnumbered urgent content");
      markRunSteerQueued({ ...input, steerId: steer.steer_id });
      markRunSteerPresented({ ...input, steerId: steer.steer_id });
      finalizeRunSteer({ ...input, steerId: steer.steer_id });
      const rotated = readRunDeliveryJournal(root, input.ownerId);
      assert.equal(rotated.receipts.length, Limits.RUN_DELIVERY_RECEIPT_LIMIT);
      assert.equal(rotated.receipts[0]!.delivery_id, "old-1");
      assert.deepEqual(rotated.completion_stream!.active, active);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Numbered kernel capture fixes topology order once and retains a switch behind every unresolved phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-switch-")), input = { tempDir: root, ownerId: "stream-switch" };
  try {
    requestCapturedFixtureStream(input);
    const parent = member("parent"), child = { ...member("child"), parent_run: parent.run,
      parent_run_instance_id: parent.run_instance_id, parent_state_dir: parent.state_dir };
    const first = captureRunCompletionStreamBatch({ ...input, members: [child, member("right"), parent] });
    assert.deepEqual(first.numbering!.member_order, [1, 2, 0]);
    const firstProjection = projectRunCompletionBatchPresentation(first);
    finishCapturedFixture(input, first);
    const second = captureRunCompletionStreamBatch({ ...input, members: [member("later-a"), member("later-b")] });
    assert.equal(second.numbering!.kind === "stream" && second.numbering!.first_index, 3);
    const original = projectRunCompletionBatchPresentation(second);
    assert.ok(original.content.startsWith("---\nindex: 3\n"));
    assert.ok(original.content.includes("\n\n---\nindex: 4\n"));
    assert.equal(original.content.includes("— Новый поток"), false);
    const previous = readRunDeliveryJournal(root, input.ownerId).completion_stream!.active!;
    assert.deepEqual(previous.counter, { state: "available", next_index: 5 });
    const target = requestRunCompletionStream(input);
    assert.notEqual(target.pending_stream_id, previous.stream_id);
    const path = getRunDeliveryJournalPath(root, input.ownerId);
    const transitions = [
      () => recordRunCompletionBatchDeliveryFailure({ ...input, batchId: second.batch_id, error: new Error("Transport uncertain") }),
      () => markRunCompletionBatchQueued({ ...input, batchId: second.batch_id }),
      () => resetRunCompletionBatchPending({ ...input, batchId: second.batch_id }),
      () => markRunCompletionBatchQueued({ ...input, batchId: second.batch_id }),
      () => markRunCompletionBatchPresented({ ...input, batchId: second.batch_id }),
    ];
    for (const transition of transitions) {
      transition();
      const bytes = fs.readFileSync(path);
      assert.deepEqual(requestRunCompletionStream(input), target);
      assert.deepEqual(fs.readFileSync(path), bytes);
      assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("blocked")] }), /active completion batch/u);
      assert.deepEqual(fs.readFileSync(path), bytes);
      const journal = readRunDeliveryJournal(root, input.ownerId);
      assert.deepEqual(journal.completion_stream, { active: previous, pending_stream_id: target.pending_stream_id });
      assert.deepEqual(projectRunCompletionBatchPresentation(journal.completion_batch!), original);
    }
    finalizeRunCompletionBatch({ ...input, batchId: second.batch_id });
    const next = captureRunCompletionStreamBatch({ ...input, members: [member("new-stream")] });
    assert.deepEqual(next.numbering, { kind: "stream", session_id: input.ownerId, stream_id: target.pending_stream_id, first_index: 0, member_order: [0] });
    assert.deepEqual(readRunDeliveryJournal(root, input.ownerId).completion_stream, {
      active: { stream_id: target.pending_stream_id, counter: { state: "available", next_index: 1 } },
    });
    assert.deepEqual(projectRunCompletionBatchPresentation(first), firstProjection);
    assert.deepEqual(projectRunCompletionBatchPresentation(second), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Numbered kernel capture freezes missing counters and whole-range exhaustion without changing earlier indices", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-counter-")), input = { tempDir: root, ownerId: "counter-loss" };
  try {
    requestCapturedFixtureStream(input);
    const numbered = captureRunCompletionStreamBatch({ ...input, members: [member("a"), member("b")] });
    const original = projectRunCompletionBatchPresentation(numbered), path = getRunDeliveryJournalPath(root, input.ownerId);
    let raw = JSON.parse(fs.readFileSync(path, "utf8"));
    raw.completion_stream.active.counter = { state: "unavailable" };
    fs.writeFileSync(path, JSON.stringify(raw));
    assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, input.ownerId).completion_batch!), original);
    finishCapturedFixture(input, numbered);
    const unknown = captureRunCompletionStreamBatch({ ...input, members: [member("c"), member("d"), member("e")] });
    assert.equal(unknown.numbering!.kind === "unavailable" && unknown.numbering!.reason, "counter_unavailable");
    const unknownProjection = projectRunCompletionBatchPresentation(unknown);
    assert.equal((unknownProjection.content.match(/^index: "\?"$/gm) ?? []).length, 3);
    assert.ok(unknownProjection.content.includes("- numbering_unavailable: counter_unavailable"));
    // This controlled fixture restoration supplies no product recovery or backup/high-water proof.
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
    raw.completion_stream.active.counter = { state: "available", next_index: Number.MAX_SAFE_INTEGER - 1 };
    fs.writeFileSync(path, JSON.stringify(raw));
    assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, input.ownerId).completion_batch!), unknownProjection);
    finishCapturedFixture(input, unknown);
    const overflow = captureRunCompletionStreamBatch({ ...input, members: [member("overflow-a"), member("overflow-b")] });
    assert.equal(overflow.numbering!.kind === "unavailable" && overflow.numbering!.reason, "range_unavailable");
    assert.equal(/^#\d+:$/m.test(formatRunCompletionBatchMessage(overflow)), false);
    assert.deepEqual(readRunDeliveryJournal(root, input.ownerId).completion_stream!.active!.counter,
      { state: "available", next_index: Number.MAX_SAFE_INTEGER - 1 });
    finishCapturedFixture(input, overflow);
    const last = captureRunCompletionStreamBatch({ ...input, members: [member("last")] });
    assert.equal(last.numbering!.kind === "stream" && last.numbering!.first_index, Number.MAX_SAFE_INTEGER - 1);
    assert.deepEqual(readRunDeliveryJournal(root, input.ownerId).completion_stream!.active!.counter,
      { state: "available", next_index: Number.MAX_SAFE_INTEGER });
    finishCapturedFixture(input, last);
    const exhausted = captureRunCompletionStreamBatch({ ...input, members: [member("exhausted")] });
    assert.equal(exhausted.numbering!.kind === "unavailable" && exhausted.numbering!.reason, "range_unavailable");
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
    raw.completion_stream.active.counter = { state: "unavailable" };
    fs.writeFileSync(path, JSON.stringify(raw));
    const target = requestRunCompletionStream(input);
    assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("too-early")] }), /active completion batch/u);
    finishCapturedFixture(input, exhausted);
    const fresh = captureRunCompletionStreamBatch({ ...input, members: [member("fresh")] });
    assert.equal(fresh.numbering!.stream_id, target.pending_stream_id);
    assert.equal(fresh.numbering!.kind === "stream" && fresh.numbering!.first_index, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Numbered journals reject mixed scopes invalid counters and accessor state without repair or coercion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-coherence-")), input = { tempDir: root, ownerId: "coherent" };
  try {
    requestCapturedFixtureStream(input);
    captureRunCompletionStreamBatch({ ...input, members: [member("a"), member("b")] });
    const path = getRunDeliveryJournalPath(root, input.ownerId), original = fs.readFileSync(path, "utf8");
    const other = "01234567-89ab-4cde-8fab-0123456789ab";
    const cases: Array<(value: any) => void> = [
      value => { delete value.completion_stream; },
      value => { value.completion_stream.active.stream_id = other; },
      value => { value.completion_batch.numbering.session_id = "foreign"; },
      value => { delete value.completion_batch.numbering; },
      value => { value.completion_stream.pending_stream_id = value.completion_stream.active.stream_id; },
      ...[0, 1, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, "2"].map(next => (value: any) => { value.completion_stream.active.counter.next_index = next; }),
      value => { value.completion_stream.active.counter = { state: "available" }; },
      value => { value.completion_stream.active.counter = { state: "unavailable", next_index: 2 }; },
      value => { value.completion_stream.active.counter = { state: "unavailable", reason: "guessed" }; },
      value => { value.completion_stream.active.extra = true; },
      value => { delete value.completion_stream.active.counter; },
      value => { value.completion_stream = { pending_stream_id: other }; },
    ];
    for (const mutate of cases) {
      const value = JSON.parse(original); mutate(value);
      const bytes = JSON.stringify(value); fs.writeFileSync(path, bytes);
      assert.throws(() => readRunDeliveryJournal(root, input.ownerId), /Completion|Active completion/u);
      assert.throws(() => requestRunCompletionStream(input), /Completion|Active completion/u);
      assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("refuse")] }), /Completion|Active completion/u);
      assert.equal(fs.readFileSync(path, "utf8"), bytes);
    }
    fs.writeFileSync(path, original);
    const parse = JSON.parse; let observations = 0;
    try {
      for (const shape of ["active", "stream_id", "counter", "state", "next_index", "inherited-counter", "coercion"] as const) {
        JSON.parse = ((text, reviver) => {
          const value = parse(text, reviver);
          if (value?.schema === "run-delivery-v1" && value.owner_id === input.ownerId) {
            const stream = value.completion_stream, active = stream.active, counter = active.counter;
            const fault = () => { observations++; throw new Error("Must not observe"); };
            const target = shape === "active" ? stream : shape === "stream_id" || shape === "counter" ? active : counter;
            if (shape === "inherited-counter") {
              delete active.counter; Object.setPrototypeOf(active, Object.defineProperty({}, "counter", { get: fault }));
            } else if (shape === "coercion") counter.next_index = { valueOf: fault, toString: fault };
            else Object.defineProperty(target, shape, { enumerable: true, get: fault });
          }
          return value;
        }) as typeof JSON.parse;
        assert.throws(() => readRunDeliveryJournal(root, input.ownerId), /Completion stream/u);
      }
    } finally { JSON.parse = parse; }
    assert.equal(observations, 0);
    assert.equal(fs.readFileSync(path, "utf8"), original);
    const caller = Object.defineProperty({ ...input, members: [member("caller")] }, "numbering", { get() { observations++; throw new Error("Caller selector"); } });
    assert.throws(() => captureRunCompletionStreamBatch(caller), /assigned only by journal capture/u);
    assert.equal(observations, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Numbered capture reconciles before after and release faults without a second allocation", async () => {
  for (const phase of ["before", "after", "release", "before-and-release", "after-and-release"] as const) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-commit-fault-")), input = { tempDir: root, ownerId: "commit-fault" };
    const path = getRunDeliveryJournalPath(root, input.ownerId), rename = fs.renameSync, mkdirSync = fs.mkdirSync;
    let lock = "";
    try {
      const target = requestCapturedFixtureStream(input), original = fs.readFileSync(path);
      lock = mutationLockPath(path);
      const failure = new Error("Capture " + phase), releaseFailure = new Error("Release " + phase);
      let replacements = 0;
      fs.renameSync = ((from, to) => {
        if (String(to) === path) {
          replacements++;
          const candidate = JSON.parse(fs.readFileSync(String(from), "utf8"));
          assert.equal(candidate.completion_stream.active.stream_id, target.pending_stream_id);
          assert.deepEqual(candidate.completion_stream.active.counter, { state: "available", next_index: 2 });
          assert.equal(candidate.completion_batch.numbering.first_index, 0);
          if (phase.startsWith("before")) throw failure;
          rename(from, to);
          if (phase.startsWith("after")) throw failure;
          return;
        }
        return rename(from, to);
      }) as typeof fs.renameSync;
      fs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
        if (phase.includes("release") && String(args[0]).startsWith(lock + ".reclaim.") && String(args[0]).endsWith(".pending")) throw releaseFailure;
        return (mkdirSync as (...values: any[]) => any)(...args);
      }) as typeof fs.mkdirSync;
      syncBuiltinESMExports();
      try {
        assert.throws(() => captureRunCompletionStreamBatch({ ...input, batchId: "fixed-capture", members: [member("a"), member("b")] }), error => {
          if (phase === "before-and-release" || phase === "after-and-release") {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [failure, releaseFailure]);
            assert.equal(error.cause, failure); return true;
          }
          return error === (phase === "release" ? releaseFailure : failure);
        });
      } finally { fs.renameSync = rename; fs.mkdirSync = mkdirSync; syncBuiltinESMExports(); }
      assert.equal(replacements, 1);
      const journal = readRunDeliveryJournal(root, input.ownerId);
      if (phase.startsWith("before")) {
        assert.deepEqual(fs.readFileSync(path), original);
        assert.equal(journal.completion_batch, undefined);
        assert.deepEqual(journal.completion_stream, target);
      } else {
        assert.equal(journal.completion_batch!.batch_id, "fixed-capture");
        assert.equal(journal.completion_batch!.numbering!.kind === "stream" && journal.completion_batch!.numbering!.first_index, 0);
        assert.deepEqual(journal.completion_stream!.active!.counter, { state: "available", next_index: 2 });
        // Only this isolated fixture's cooperative file lock can survive the controlled release fault.
        if (phase.includes("release")) fs.rmSync(lock, { recursive: true, force: true });
        const bytes = fs.readFileSync(path);
        assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: [member("must-not-reallocate")] }), /active completion batch/u);
        assert.deepEqual(fs.readFileSync(path), bytes);
      }
    } finally {
      fs.renameSync = rename; fs.mkdirSync = mkdirSync; syncBuiltinESMExports();
      if (lock) fs.rmSync(lock, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Numbered capture preflights journal overflow and preserves separate orphan inventory effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-stream-inventory-fault-")), input = { tempDir: root, ownerId: "inventory-fault" };
  const rename = fs.renameSync, write = fs.writeFileSync;
  try {
    requestCapturedFixtureStream(input);
    const path = getRunDeliveryJournalPath(root, input.ownerId), original = fs.readFileSync(path);
    const failure = new Error("After inventory, before journal replacement");
    let inventory = "", inventories = 0;
    fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (basename(String(args[0])).startsWith("inventory-") && String(args[0]).endsWith(".json")) { inventory = String(args[0]); inventories++; }
      return (write as (...values: any[]) => any)(...args);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => captureRunCompletionStreamBatch({ ...input, members: Array.from({ length: 256 }, (_, i) =>
        ({ ...member("overflow" + i), output: "x".repeat(4000) })) }), /journal exceeds the byte limit/u);
      assert.equal(inventories, 0);
      assert.deepEqual(fs.readFileSync(path), original);
      fs.renameSync = ((from, to) => { if (String(to) === path) throw failure; return rename(from, to); }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      const capture = { ...input, batchId: "inventory-capture", now: new Date("2026-08-31T12:00:00.000Z"),
        members: Array.from({ length: 65 }, (_, i) => ({ ...member("n" + i), artifacts: undefined, summary: "Run completed." })) };
      assert.throws(() => captureRunCompletionStreamBatch(capture), error => error === failure);
      assert.equal(inventories, 1);
      const orphan = fs.readFileSync(inventory);
      assert.deepEqual(fs.readFileSync(path), original);
      fs.renameSync = rename; syncBuiltinESMExports();
      assert.equal(readRunDeliveryJournal(root, input.ownerId).completion_batch, undefined);
      assert.throws(() => captureRunCompletionStreamBatch(capture), /EEXIST/u);
      assert.deepEqual(fs.readFileSync(inventory), orphan);
      assert.deepEqual(fs.readFileSync(path), original);
    } finally { fs.renameSync = rename; fs.writeFileSync = write; syncBuiltinESMExports(); }
  } finally { fs.renameSync = rename; fs.writeFileSync = write; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

function finishCapturedFixture(input: { tempDir: string; ownerId: string }, batch: { batch_id: string }): void {
  assert.equal(markRunCompletionBatchQueued({ ...input, batchId: batch.batch_id }), true);
  assert.equal(markRunCompletionBatchPresented({ ...input, batchId: batch.batch_id }), true);
  assert.equal(finalizeRunCompletionBatch({ ...input, batchId: batch.batch_id }), true);
}

function requestCapturedFixtureStream(input: { tempDir: string; ownerId: string }) {
  const legacy = admitRunCompletionBatch({ ...input, members: [member("before-stream")] });
  finishCapturedFixture(input, legacy);
  return requestRunCompletionStream(input);
}

// Snapshot projection fixtures below assign no counter; journal admission separately checks the active session/stream.
test("Completion numbering snapshots keep captured scope order and reasons through pure projection and phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-numbering-view-"));
  try {
    const members = [member("parent"), { ...member("child"), parent_run: "parent", parent_run_instance_id: "generation-parent", parent_state_dir: fixtureStateDir("parent") }, member("peer")];
    members[0]!.output = "#0:\n— Новый поток authored · отсчёт с #0 —\n- technical: authored\r\n`````";
    admitRunCompletionBatch({ members, ownerId: "numbering-owner", tempDir: root });
    const batch = { batch_id: "saved-numbering", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const, text_budget: 6000, members };
    const saved = JSON.stringify(readRunDeliveryJournal(root, "numbering-owner"));
    const stream = "01234567-89ab-4cde-8fab-0123456789ab", common = { session_id: "numbering-owner", member_order: [2, 0, 1] };
    const facts = [
      { ...common, kind: "stream" as const, stream_id: stream, first_index: 41 },
      { ...common, kind: "stream" as const, stream_id: stream, first_index: 0 },
      { ...common, kind: "stream" as const, stream_id: stream, first_index: Number.MAX_SAFE_INTEGER - batch.members.length },
      { ...common, kind: "unavailable" as const, stream_id: stream, reason: "counter_unavailable" as const },
      { ...common, kind: "unavailable" as const, stream_id: stream, reason: "range_unavailable" as const },
      { ...common, kind: "unavailable" as const, reason: "stream_state_unavailable" as const },
    ];
    const read = fs.readFileSync;
    fs.readFileSync = (() => assert.fail("Numbered projection cannot reread sources")) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      for (const numbering of facts) {
        const snapshot = { ...batch, numbering }, before = JSON.stringify(snapshot);
        const projected = projectRunCompletionBatchPresentation(snapshot), compact = readRunCompletionPresentation(projected.content, projected.presentation)!;
        assert.equal(compact.compact, true);
        assert.equal(compact.text.includes("completion_numbering"), false);
        assert.ok(compact.text.includes("authored"));
        assert.ok(compact.text.indexOf("run: peer") < compact.text.indexOf("run: parent"));
        assert.ok(compact.text.indexOf("run: parent") < compact.text.indexOf("run: child"));
        assert.deepEqual(readRunCompletionRecordMarker(projected.content), { batchId: batch.batch_id, start: projected.content.lastIndexOf("\n<!--"), single: false, headers: true });
        if (numbering.kind === "stream") {
          for (let index = 0; index < 3; index++) assert.ok(compact.text.includes("index: " + (numbering.first_index + index) + "\n"));
          if (numbering.first_index === 0) assert.ok(compact.text.startsWith("— Новый поток " + stream + " · отсчёт с #0 —\n---\nindex: 0"));
          else assert.ok(compact.text.startsWith("---\nindex: " + numbering.first_index + "\n"));
        } else {
          assert.equal((compact.text.match(/^index: "\?"$/gm) ?? []).length, 3);
          assert.ok(compact.text.includes("- numbering_unavailable: " + numbering.reason));
          assert.equal(compact.text.startsWith("— Новый поток"), false);
        }
        for (const phase of ["pending", "queued", "presented"] as const) {
          const time = "2026-08-31T12:01:00.000Z";
          const replay = { ...snapshot, phase, ...(phase === "pending" ? {} : { queued_at: time }), ...(phase === "presented" ? { presented_at: time } : {}) };
          assert.deepEqual(projectRunCompletionBatchPresentation(replay), projected);
        }
        for (const hints of [undefined, {}, { ...projected.presentation, content_sha256: "wrong" }, { ...projected.presentation, compact_ranges: [[0, 2]] }]) {
          assert.equal(readRunCompletionPresentation(projected.content, hints)!.text, projected.content);
        }
        assert.equal(JSON.stringify(snapshot), before);
      }
    } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
    assert.equal(JSON.stringify(readRunDeliveryJournal(root, "numbering-owner")), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Completion numbering snapshots refuse unsafe ranges ambiguous order and accessors without activating journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-numbering-schema-"));
  try {
    const ownerId = "numbering-schema", members = [member("a"), member("b"), member("c")];
    const batch = { batch_id: "saved-numbering-schema", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const, text_budget: 6000, members };
    admitRunCompletionBatch({ members, ownerId, tempDir: root });
    const seedPath = getRunDeliveryJournalPath(root, ownerId), seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    fs.writeFileSync(seedPath, JSON.stringify({ ...seed, completion_batch: batch }));
    const valid = { kind: "stream" as const, session_id: ownerId, stream_id: "01234567-89ab-4cde-8fab-0123456789ab", first_index: 41, member_order: [0, 1, 2] };
    for (const numbering of [null, [], {}, { ...valid, kind: "wrong" }, { ...valid, session_id: "" }, { ...valid, stream_id: "wrong" },
      { ...valid, first_index: -1 }, { ...valid, first_index: Number.MAX_SAFE_INTEGER - 1 }, { ...valid, first_index: NaN },
      { ...valid, member_order: [0, 0, 2] }, { ...valid, member_order: [0, 1] }, { ...valid, member_order: [0, 1, 3] },
      { ...valid, kind: "unavailable", reason: "guessed" }, { ...valid, extra: "not captured" }]) {
      assert.throws(() => projectRunCompletionBatchPresentation({ ...batch, numbering } as any), /Completion numbering/u);
    }
    let getters = 0;
    for (const key of ["kind", "first_index", "member_order"] as const) {
      const numbering = Object.defineProperty({ ...valid }, key, { enumerable: true, get() { getters++; throw new Error("Must not invoke"); } });
      assert.throws(() => projectRunCompletionBatchPresentation({ ...batch, numbering }), /Completion numbering/u);
    }
    const order = [0, 1, 2];
    Object.defineProperty(order, "0", { enumerable: true, get() { getters++; throw new Error("Must not invoke order"); } });
    assert.throws(() => projectRunCompletionBatchPresentation({ ...batch, numbering: { ...valid, member_order: order } }), /member order/u);
    const accessor = Object.defineProperty({ ...batch }, "numbering", { get() { getters++; throw new Error("Must not invoke snapshot"); } });
    assert.throws(() => projectRunCompletionBatchPresentation(accessor), /Completion numbering/u);
    assert.equal(getters, 0);
    const inherited = Object.setPrototypeOf({ ...batch }, { numbering: valid });
    assert.deepEqual(projectRunCompletionBatchPresentation(inherited), projectRunCompletionBatchPresentation(batch));
    for (const result_layout of [undefined, "records", "run_headers"] as const) {
      assert.throws(() => projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, result_layout, numbering: valid }), /captured heading/u);
    }
    assert.throws(() => admitRunCompletionBatch({ members: batch.members, tempDir: root, ownerId: "selector", numbering: valid } as any), /assigned only by journal capture/u);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, "selector")), false);
    const path = getRunDeliveryJournalPath(root, ownerId), journal = JSON.parse(fs.readFileSync(path, "utf8"));
    journal.completion_batch.numbering = valid;
    const bytes = JSON.stringify(journal); fs.writeFileSync(path, bytes);
    assert.throws(() => readRunDeliveryJournal(root, ownerId), /no matching active session stream/u);
    assert.throws(() => requestRunCompletionStream({ tempDir: root, ownerId }), /no matching active session stream/u);
    assert.equal(fs.readFileSync(path, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Completion numbering snapshots keep whole omission budgets and bind inventory scope even when zero is not shown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-numbering-budget-"));
  try {
    const stream = "01234567-89ab-4cde-8fab-0123456789ab";
    for (const count of [80, Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS]) {
      const members = Array.from({ length: count }, (_, i) => ({ ...member("n" + i), summary: "Run completed.", artifacts: undefined }));
      const batch_id = "saved-numbering-" + count, created_at = "2026-08-31T12:00:00.000Z";
      const seed = admitRunCompletionBatch({ members, batchId: batch_id, now: new Date(created_at), ownerId: "numbering-" + count, tempDir: root });
      const batch = { batch_id, created_at, phase: "pending" as const, presentation_format: "ax_records" as const,
        result_layout: "frontmatter_v2" as const, text_budget: 0, members, inventory_source: seed.inventory_source };
      const numbering = { kind: "stream" as const, session_id: "numbering-" + count, stream_id: stream, first_index: 100, member_order: members.map((_, i) => i) };
      assert.throws(() => projectRunCompletionBatchPresentation({ ...batch, numbering }), /inventory source binding/u);
      const old = JSON.parse(fs.readFileSync(batch.inventory_source!.path, "utf8"));
      const { members: inventoryMembers, ...header } = old;
      const source = JSON.stringify({ ...header, numbering, members: inventoryMembers }, null, 2) + "\n";
      const hash = createHash("sha256").update(source).digest("hex");
      const inventory_source = { path: join(dirname(batch.inventory_source!.path), "inventory-" + hash + ".json"),
        sha256: hash, bytes_total: Buffer.byteLength(source), members_total: count };
      const projected = projectRunCompletionBatchPresentation({ ...batch, numbering, inventory_source });
      assert.ok(Buffer.byteLength(projected.content) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
      assert.equal((projected.content.match(/^index: \d+$/gm) ?? []).length, Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS);
      assert.ok(projected.content.startsWith("---\nindex: 100\n"));
      assert.ok(projected.content.includes("- omitted_results: " + (count - Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS)));
      assert.ok(projected.content.includes(JSON.stringify(inventory_source.path)));
      assert.equal(readRunCompletionPresentation(projected.content, projected.presentation)!.compact, true);
    }
    const batch = { batch_id: "saved-zero-omitted", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "headings_outcomes" as const,
      members: [{ ...member("zero-omitted"), output: "`".repeat(4000) }] };
    const projected = projectRunCompletionBatchPresentation({ ...batch, numbering: { kind: "stream", session_id: "s".repeat(4096), stream_id: stream, first_index: 0, member_order: [0] } });
    assert.ok(Buffer.byteLength(projected.content) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
    assert.ok(projected.content.startsWith("— Новый поток " + stream + " · отсчёт с #0 —\n- omitted_results: 1"));
    assert.equal((projected.content.match(/^#\d+:$/gm) ?? []).length, 0);
    const compact = readRunCompletionPresentation(projected.content, projected.presentation)!;
    assert.equal(compact.compact, true);
    assert.ok(compact.text.includes("- omitted_results: 1"));
    assert.ok(compact.text.includes("— Новый поток " + stream));
    const unavailable = projectRunCompletionBatchPresentation({ ...batch, numbering: { kind: "unavailable", session_id: "s".repeat(4096),
      stream_id: stream, reason: "counter_unavailable", member_order: [0] } });
    assert.ok(unavailable.content.startsWith("- omitted_results: 1\n"));
    const unknownView = readRunCompletionPresentation(unavailable.content, unavailable.presentation)!;
    assert.equal(unknownView.compact, true);
    assert.ok(unknownView.text.includes("- numbering_unavailable: counter_unavailable"));
    assert.equal(unknownView.text.includes("— Новый поток"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Synthetic model frames still use canonical, drive-qualified paths on Windows; no IO authority.
function fixtureStateDir(run: string): string { return join(process.platform === "win32" ? "C:\\tmp\\runs" : "/tmp/runs", run); }

function member(
  run: string,
  generation = `generation-${run}`,
): RunCompletionBatchMember {
  return {
    artifacts: { report: `/tmp/${run}/report.md` },
    run,
    run_instance_id: generation,
    state_dir: fixtureStateDir(run),
    status: "done",
    summary: `Run ${run} completed`,
    terminal_at: "2026-08-31T12:00:00.000Z",
  };
}

// Manufacture retained snapshots only in isolated fixtures. This is not a production writer or a journal migration.
function admitRetainedFixture(input: Parameters<typeof admitRunCompletionBatch>[0] & { resultLayout?: "headings"; presentationFormat?: "ax_records" | "ax_records_v1" | "ax_records_v2" | "ax_records_v3" }) {
  const { presentationFormat, resultLayout, ...current } = input;
  // Construct historical facts from fixture inputs, never from a fresh core snapshot or its frozen share.
  const batchId = current.batchId ?? "saved-fixture-only";
  const now = current.now ?? new Date("2026-08-31T12:00:00.000Z");
  const retained: Record<string, unknown> = { batch_id: batchId, created_at: now.toISOString(), phase: "pending",
    members: JSON.parse(JSON.stringify(current.members)), navigation_handoff: current.fileNavigation === undefined ? "current_session_request" : "captured_file_locations",
    ...(current.fileNavigation === undefined ? {} : { file_navigation: current.fileNavigation }) };
  const initialized = admitRunCompletionBatch({ ...current, batchId, now }), path = getRunDeliveryJournalPath(input.tempDir, input.ownerId);
  const journal = JSON.parse(fs.readFileSync(path, "utf8"));
  // Inventory is shared metadata bound to these exact inputs, not a layout/text-budget capture.
  if (initialized.inventory_source) retained.inventory_source = initialized.inventory_source;
  if (resultLayout) retained.result_layout = resultLayout;
  if (presentationFormat) retained.presentation_format = presentationFormat;
  else retained.excerpt_format = "bracketed_omissions_v1";
  journal.completion_batch = retained;
  fs.writeFileSync(path, JSON.stringify(journal));
  return readRunDeliveryJournal(input.tempDir, input.ownerId).completion_batch!;
}

function capturedLocations(members: readonly RunCompletionBatchMember[]) {
  const slots = [["context_index", "context-index.json", "json"], ["result", "result.json", "json"], ["metadata", "run.json", "json"],
    ["execution", "execution.json", "json"], ["published_sessions", "evidence/sessions.json", "json"], ["trace", "trace.jsonl", "jsonl"],
    ["control", "controls.jsonl", "jsonl"], ["stdout", "stdout.log", "text"], ["stderr", "stderr.log", "text"]];
  return members.map((member, member_index) => ({ member_index, locations: {
    state: "available" as const, content_scope: "file_locations_only" as const, file_inventory_scope: "canonical_starting_locations" as const,
    run: member.run, run_instance_id: member.run_instance_id, directory: member.state_dir,
    files: slots.map(([role, leaf, format]) => ({ role, format_hint: format as "json" | "jsonl" | "text", mutable: true as const,
      state: "present" as const, path: join(member.state_dir, leaf), bytes_total: 10 })) } }));
}

function diagnosticBinding(item: RunCompletionBatchMember, text = " \uFEFF\r\n🌍\uFFFD````  \r\n", suffix = "TAIL") {
  return { result_diagnostics: { source: { path: join(item.state_dir, "evidence", `result-diagnostics-${"d".repeat(64)}.json`),
    run_instance_id: item.run_instance_id, sha256: createHash("sha256").update(text + suffix).digest("hex") },
    bytes_total: 5000, fields: ["error", "failure_reason"] as ("error" | "failure_reason" | "command")[] },
    diagnostic_excerpt: { field: "error" as const, text, bytes_total: Buffer.byteLength(text + suffix), shown_bytes: { start: 0, end: Buffer.byteLength(text) },
      chars_total: Array.from(text + suffix).length, chars_shown: Array.from(text).length, chars_omitted: Array.from(suffix).length, truncated: !!suffix } };
}

function omissionMembers(suffix = "TAIL"): RunCompletionBatchMember[] {
  const primary = { ...member("p"), artifacts: undefined, summary: "P", primary_text: primaryBinding(member("p"), "🌍", suffix) };
  const diagnostic = { ...member("d"), artifacts: undefined, summary: "D", status: "failed" as const, ...diagnosticBinding(member("d"), "界", suffix) };
  delete primary.artifacts; delete diagnostic.artifacts;
  return [primary, diagnostic];
}

function retainedSharedKindFixture() {
  const [primary, diagnostic] = omissionMembers();
  primary.summary = "Run completed."; diagnostic.summary = "Run failed.";
  const response = { ...member("response"), artifacts: undefined, summary: "Run completed.", primary_text: {
    output: { ...primaryBinding(member("response"), "ACTOR ANSWER 🌍", "").output, text_basis: "actor_response" as const, upstream_truncated: false } } };
  const fallback = { ...member("fallback"), artifacts: undefined, summary: "Run completed.", output: "Untracked text\r\n🌍" };
  return { batch_id: "retained-shared-kind-labels", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
    presentation_format: "ax_records" as const, result_layout: "headings_shared_results" as const, text_budget: 6000,
    members: [primary, response, diagnostic, fallback] };
}

test("Saved shared-result packets retain original kind labels, bytes and phase replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-saved-kinds-"));
  try {
    const retained = retainedSharedKindFixture(), projected = projectRunCompletionBatchPresentation(retained);
    assert.match(projected.content, /- result_kind: primary/); assert.match(projected.content, /- result_kind: response/);
    assert.match(projected.content, /- result_kind: diagnostic/); assert.match(projected.content, /- result_kind: legacy/);
    assert.match(projected.content, /- legacy_basis:/);
    let portable = projected.content;
    for (const item of retained.members) for (const source of [item.primary_text?.output?.source, item.result_diagnostics?.source]) {
      if (source) portable = portable.replaceAll(JSON.stringify(source.path), JSON.stringify(`/tmp/runs/${item.run}/evidence/${basename(source.path)}`));
    }
    assert.equal(createHash("sha256").update(portable).digest("hex"), "4428de318b8ebaa029d3588ab7e8e705b9a80fa5cf08b6a2cc7151916207e266");
    assert.ok(readRunCompletionPresentation(projected.content, projected.presentation));
    admitRunCompletionBatch({ members: retained.members, ownerId: "saved-kinds", tempDir: root });
    const path = getRunDeliveryJournalPath(root, "saved-kinds"), journal = JSON.parse(fs.readFileSync(path, "utf8"));
    fs.writeFileSync(path, JSON.stringify({ ...journal, completion_batch: retained }));
    for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition?.({ batchId: retained.batch_id, ownerId: "saved-kinds", tempDir: root });
      assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "saved-kinds").completion_batch!), projected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained frontmatter V1 unknown index preserves its complete projection and hint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-retained-yaml-"));
  try {
    const retained = { presentation_format: "ax_records" as const, result_layout: "frontmatter_v1" as const,
      batch_id: "retained-frontmatter-yaml", created_at: "2026-11-04T00:00:00.000Z", phase: "pending" as const,
      members: [{ run: "worker", run_instance_id: "generation-worker", state_dir: resolve("retained-frontmatter-yaml"),
        status: "done" as const, summary: "Run completed.", terminal_at: "2026-11-04T00:00:00.000Z" }],
      numbering: { kind: "unavailable" as const, session_id: "yaml-contract", stream_id: "01234567-89ab-4cde-8fab-0123456789ab",
        reason: "counter_unavailable" as const, member_order: [0] } };
    const projected = projectRunCompletionBatchPresentation(retained);
    assert.equal(createHash("sha256").update(projected.content).digest("hex"), "90e29fb36087e2620fe0cf150b4238bce8a6d1dcc68ee922a1cf71ee8604610e");
    assert.equal(createHash("sha256").update(JSON.stringify(projected.presentation)).digest("hex"), "054e31a6c32ea6a89aacb81bbafe79b9ff10961666d48396023c8e7e306998d7");
    assert.match(projected.content, /^---\nindex: \?\n/u);
    assert.equal(readRunCompletionPresentation(projected.content, projected.presentation)!.compact, true);
    admitRunCompletionBatch({ members: retained.members, ownerId: "yaml-contract", tempDir: root });
    const path = getRunDeliveryJournalPath(root, "yaml-contract"), journal = JSON.parse(fs.readFileSync(path, "utf8"));
    fs.writeFileSync(path, JSON.stringify({ ...journal, completion_batch: { ...retained, text_budget: 0 },
      completion_stream: { active: { stream_id: retained.numbering.stream_id, counter: { state: "unavailable" } } } }));
    for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition?.({ batchId: retained.batch_id, ownerId: "yaml-contract", tempDir: root });
      assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "yaml-contract").completion_batch!), projected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Fresh frontmatter is public SDK YAML with typed indices and exact authored bodies", async () => {
  const { parseFrontmatter } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-yaml-contract-")), input = { tempDir: root, ownerId: "yaml-contract" };
  try {
    requestCapturedFixtureStream(input);
    for (const unavailable of [false, true]) {
      for (const run of ["worker", "null", "true", "false", "yes", "no", "on", "off", "?", "multi\r\nkind: diagnostic\n---"]) {
        const text = "---\nindex: ?\nrun: authored\n---\n```ts\r\nconst world = '🌍';\n";
        const base = { ...member("yaml"), run, summary: "Run completed.", artifacts: undefined };
        const item = { ...base, primary_text: primaryBinding(base, text, "") };
        const batch = captureRunCompletionStreamBatch({ ...input, members: [item] });
        assert.equal(batch.result_layout, "frontmatter_v2");
        const reads = fs.readFileSync;
        let projected: ReturnType<typeof projectRunCompletionBatchPresentation>;
        try {
          fs.readFileSync = (() => { throw new Error("Projection must not read sources"); }) as typeof reads;
          syncBuiltinESMExports();
          projected = projectRunCompletionBatchPresentation(batch);
        } finally { fs.readFileSync = reads; syncBuiltinESMExports(); }
        assert.ok(projected.presentation?.format !== "completion_yaml_core_v1");
        const header = projected.presentation!.blocks!.find(([kind]) => kind === "header")!;
        const body = projected.presentation!.blocks!.find(([kind]) => kind === "body")!;
        const parsed = parseFrontmatter(projected.content.slice(header[1], header[2]) + "\n" + text);
        assert.equal(parsed.frontmatter.index, unavailable ? "?" : batch.numbering!.kind === "stream" ? batch.numbering!.first_index : undefined);
        assert.equal(typeof parsed.frontmatter.index, unavailable ? "string" : "number");
        assert.equal(parsed.frontmatter.run, run);
        // The SDK normalizes its returned body; the actual model packet must not.
        assert.equal(parsed.body, text.replaceAll("\r\n", "\n").trim());
        assert.ok(projected.content.includes("---\n\n" + text));
        assert.equal(projected.content.slice(body[1], body[2]), text);
        assert.equal(readRunCompletionPresentation(projected.content, projected.presentation)!.compact, true);
        assert.equal(projected.presentation!.format, "completion_frontmatter_v1");
        const v1 = projectRunCompletionBatchPresentation({ ...batch, result_layout: "frontmatter_v1" });
        assert.ok(v1.presentation?.format !== "completion_yaml_core_v1");
        if (!unavailable) assert.deepEqual(projected, v1);
        else {
          const v1Header = v1.presentation!.blocks!.find(([kind]) => kind === "header")!;
          assert.equal(projected.content.slice(header[1], header[2]),
            v1.content.slice(v1Header[1], v1Header[2]).replace("index: ?\n", 'index: "?"\n'));
        }
        finishCapturedFixture(input, batch);
      }
      const path = getRunDeliveryJournalPath(root, input.ownerId), journal = JSON.parse(fs.readFileSync(path, "utf8"));
      journal.completion_stream.active.counter = { state: "unavailable" };
      fs.writeFileSync(path, JSON.stringify(journal));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Fresh frontmatter separates compiler blocks from arbitrary authored Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-frontmatter-"));
  try {
    const text = "---\nindex: 99\nkind: diagnostic\n---\n[7 characters omitted]\n```ts\r\nconst world = '🌍';\n";
    const base = { ...member("front"), summary: "Run completed.", artifacts: undefined };
    const item = { ...base, primary_text: primaryBinding(base, text, "🚀tail") };
    const batch = admitRunCompletionBatch({ members: [item], ownerId: "front", tempDir: root });
    assert.equal(batch.result_layout, "completion_yaml_files_v2");
    const projected = projectRunCompletionBatchPresentation(batch), rows = coreRows(projected.content);
    assert.deepEqual([rows[0].metadata.index, rows[0].metadata.run, rows[0].metadata.state, rows[0].metadata.kind], [undefined, "front", "done", "primary"]);
    assert.deepEqual(rows[0].parts, [{ body: text }, { marker: "\n" }, { marker: "[5 characters omitted]" }]);
    assert.ok(projected.content.includes(text + "\n[5 characters omitted]"));
    assert.doesNotMatch(projected.content, /^#0:|^- (?:result|preview):/mu);
    const view = readRunCompletionPresentation(projected.content, projected.presentation)!;
    assert.equal(view.compact, true);
    assert.ok(view.text.includes(text));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained frontmatter typed blocks bind every byte and reject forged or accessor hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-frontmatter-blocks-"));
  try {
    const members = retainedSharedKindFixture().members;
    Object.assign(members[1]!.primary_text!.output!, { upstream_truncated: true });
    // Saved V2 fixture facts, independent from fresh core capture and its quota.
    const batch = { batch_id: "saved-blocks", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const, text_budget: 6000, members };
    const { content, presentation } = projectRunCompletionBatchPresentation(batch);
    const view = readRunCompletionPresentation(content, presentation)!;
    assert.equal(view.compact, true);
    assert.equal(readRunCompletionRecordMarker(content)?.batchId, batch.batch_id);
    assert.equal(presentation!.format, "completion_frontmatter_v1");
    assert.ok(view.blocks!.some(([kind]) => kind === "body"));
    assert.doesNotMatch(content, /"(?:chars_shown|chars_total|utf8_range|secondary_diagnostic_excerpt)":/u);
    assert.doesNotMatch(content, /"coverage":/u);
    assert.match(content, /\[omitted: unknown\] \(upstream completeness unproven\)/u);
    assert.match(content, /\[omitted: unknown\] \(summary\/fallback text: original completeness\/privacy unproven\)/u);
    let gets = 0;
    const accessor = Object.defineProperty({ ...presentation }, "blocks", { get() { gets++; throw Error("No getter"); } });
    const nested = [...presentation!.blocks!];
    nested[0] = Object.defineProperty([...nested[0]!], "1", { get() { gets++; throw Error("No nested getter"); } }) as any;
    for (const hint of [accessor, { ...presentation, blocks: nested },
      { ...presentation, blocks: [...presentation!.blocks!].reverse() },
      { ...presentation, blocks: presentation!.blocks!.filter(([kind]) => kind !== "body") },
      { ...presentation, compact_ranges: presentation!.compact_ranges.slice(1) },
      { ...presentation, content_sha256: "0".repeat(64) }]) {
      assert.deepEqual(readRunCompletionPresentation(content, hint), { text: content, compact: false, records: true });
    }
    assert.equal(gets, 0);
    assert.equal(readRunCompletionPresentation(content, undefined)!.text, content);
    assert.equal(readRunCompletionPresentation(content.replace("index: 0", "index: 7"), presentation)!.compact, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Frontmatter metadata serializes original scalar values, never generic rendered Markdown", () => {
  for (const run of ["null", "yes", "off", "multi\r\nkind: diagnostic\n---", "`literal` 🌍: [x]", "line\u2028break"]) {
    const item = { ...member("scalar"), run, summary: "Run completed.", artifacts: undefined };
    const projected = projectRunCompletionBatchPresentation({ batch_id: "scalar", created_at: "2026-08-31T12:00:00.000Z", phase: "pending",
      presentation_format: "ax_records", result_layout: "frontmatter_v1", text_budget: 0, members: [item] });
    const view = readRunCompletionPresentation(projected.content, projected.presentation)!;
    assert.equal(view.compact, true);
    const line = projected.content.split("\n").find(line => line.startsWith("run: "))!;
    assert.equal(JSON.parse(line.slice(5)), run);
    assert.equal((projected.content.match(/^state:/gmu) ?? []).length, 1);
    assert.equal(readRunCompletionRecordMarker(projected.content)!.batchId, "scalar");
  }
});

test("Frontmatter full-result and decimal omission discontinuities retain the largest fair fitting prefix", () => {
  const item = (size: number) => {
    const base = { ...member("decimal"), summary: "Run completed.", artifacts: undefined };
    const text = "A".repeat(size);
    return { ...base, primary_text: primaryBinding(base, text.slice(0, 160), text.slice(160)), completion_text: { text, shown_bytes: { start: 0, end: size } } };
  };
  const shape = { batch_id: "decimal", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
    presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const };
  let low = 0, high = 49152;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const projected = projectRunCompletionBatchPresentation({ ...shape, members: [item(middle)] });
    assert.ok(projected.presentation?.format !== "completion_yaml_core_v1");
    const lost = projected.presentation!.blocks!.some(([kind]) => kind === "marker");
    if (lost) high = middle - 1; else low = middle;
  }
  for (const size of [low - 1, low, low + 1, low + 9, low + 10, low + 99, low + 100, 49152]) {
    const projected = projectRunCompletionBatchPresentation({ ...shape, members: [item(size)] });
    const view = readRunCompletionPresentation(projected.content, projected.presentation)!;
    assert.equal(view.compact, true);
    const [, a, b] = view.blocks!.find(([kind]) => kind === "body")!;
    const retained = b - a;
    assert.equal(size <= low, retained === size);
    assert.ok(Buffer.byteLength(projected.content) <= 49152);
    if (retained < size) {
      assert.ok(projected.content.includes(`[${size - retained} characters omitted]`));
      const forced = projectRunCompletionBatchPresentation({ ...shape, text_budget: retained + 1, members: [item(size)] });
      assert.ok(forced.presentation?.format !== "completion_yaml_core_v1");
      const forcedBody = forced.presentation!.blocks!.find(([kind]) => kind === "body");
      assert.equal(forcedBody, undefined, "One extra source byte cannot fit the frozen packet scaffolding");
    }
  }
});

test("Frontmatter preserves empty and CRLF scalar cuts under frozen tiny shares", () => {
  for (const text of ["", "🌍\r\n界🚀tail", "---\nrun: forged\n---\n```\n> - raw\n"]) {
    const base = { ...member("tiny"), summary: "Run completed.", artifacts: undefined };
    const item = { ...base, primary_text: primaryBinding(base, text, ""), completion_text: { text, shown_bytes: { start: 0, end: Buffer.byteLength(text) } } };
    for (const quota of [0, 1, 3, 4, 5, 6, 9, 10, 99]) {
      const packet = { batch_id: "tiny", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
        presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const, text_budget: quota, members: [item] };
      const projected = projectRunCompletionBatchPresentation(packet);
      const view = readRunCompletionPresentation(projected.content, projected.presentation)!;
      assert.equal(view.compact, true);
      const bodies = view.blocks!.filter(([kind]) => kind === "body");
      assert.equal(bodies.length, 1);
      const [, a, b] = bodies[0]!;
      const retained = projected.content.slice(a, b);
      assert.ok(text.startsWith(retained));
      assert.equal(Buffer.from(retained).toString("utf8"), retained);
      assert.ok(!(retained.endsWith("\r") && text[retained.length] === "\n"));
      const lost = [...text].length - [...retained].length;
      const markers = view.blocks!.filter(([kind]) => kind === "marker").map(([, start, end]) => projected.content.slice(start, end));
      assert.deepEqual(markers, lost ? [`[${lost} characters omitted]`] : []);
      assert.ok(Buffer.byteLength(projected.content) <= 49152);
    }
  }
});

test("Fresh completion kinds classify admitted sources without upgrading fallback text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-simple-kinds-"));
  try {
    const batch = admitRunCompletionBatch({ members: retainedSharedKindFixture().members, ownerId: "simple", tempDir: root });
    const projected = projectRunCompletionBatchPresentation(batch), content = projected.content;
    assert.equal(batch.result_layout, "completion_yaml_files_v2");
    const rows = coreRows(content);
    assert.equal(rows.filter(row => row.metadata.kind === "primary").length, 2);
    assert.equal(rows.filter(row => row.metadata.kind === "diagnostic").length, 1);
    assert.doesNotMatch(content, /^- (?:result_kind|preview_kind|legacy_basis):|^- kind: (?:legacy|response)$/mu);
    assert.ok(content.includes("Untracked text\r\n🌍"));
    assert.match(content, /\[omitted: unknown\] \(summary\/fallback text: original completeness\/privacy unproven\)/);
    assert.equal(rootedEntries(rows[1].metadata).find(entry => entry.role === "primary").text_basis, "actor_response");
    const fallbackRecord = rows.find(row => row.metadata.run === "fallback")!;
    assert.equal(fallbackRecord.metadata.kind, undefined);
    assert.ok(readRunCompletionPresentation(content, projected.presentation));
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition({ batchId: batch.batch_id, ownerId: "simple", tempDir: root });
      assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "simple").completion_batch!), projected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Shared48KiB completion budgets preserve whole results or exact fair previews across replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-shared-results-"));
  const item = (run: string, text: string): RunCompletionBatchMember => {
    const base = { ...member(run), summary: "Run completed.", artifacts: undefined }, prefix = [...text].slice(0, 160).join("");
    const bytes = Buffer.from(text); let end = Math.min(bytes.length, 48 * 1024);
    while (end && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end < bytes.length && bytes[end - 1] === 13 && bytes[end] === 10) end--;
    return { ...base, primary_text: primaryBinding(base, prefix, text.slice(prefix.length)),
      completion_text: { text: bytes.subarray(0, end).toString("utf8"), shown_bytes: { start: 0, end } } };
  };
  try {
    for (const [count, size, full] of [[1, 32 * 1024, true], [2, 20 * 1024, true], [3, 12 * 1024, true],
      [1, 64 * 1024, false], [2, 24 * 1024, false], [3, 16 * 1024, false]] as const) {
      const ownerId = "c-" + count + "-s-" + size;
      const members = Array.from({length: count}, (_, i) => item("r" + i, "A".repeat(size)));
      const batch = admitRunCompletionBatch({ members, ownerId, tempDir: root });
      const projected = projectRunCompletionBatchPresentation(batch);
      assert.ok(Buffer.byteLength(projected.content) <= 48 * 1024); assert.doesNotMatch(projected.content, /- omitted_results:/);
      assert.equal(projected.presentation?.format, "completion_yaml_core_v1");
      const bodies = coreRows(projected.content).flatMap(row => row.parts.flatMap(part => "body" in part ? [part.body] : []));
      assert.equal(bodies.length, count);
      assert.equal((projected.content.match(/^\[[1-9]\d* characters omitted\]$/gmu) ?? []).length, full ? 0 : count);
      const view = readRunCompletionPresentation(projected.content, projected.presentation)!; assert.equal(view.compact, true);
      assert.equal(bodies.reduce((sum, body) => sum + body.length, 0), full ? count * size : count * batch.text_budget!);
      if (!full) assert.ok(batch.text_budget! < 48 * 1024 / count);
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 1024 * 1024);
      for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        phase({ batchId: batch.batch_id, ownerId, tempDir: root });
        assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, ownerId).completion_batch!), projected);
      }
    }
    for (const [text, expected] of [['"'.repeat(32 * 1024), "result"], ["\n".repeat(32 * 1024), "result"]] as const) {
      const selected = admitRunCompletionBatch({ members: [item("escaped", text)], ownerId: "escaped-" + text.charCodeAt(0) + "-" + expected, tempDir: root });
      const content = formatRunCompletionBatchMessage(selected);
      assert.deepEqual(coreRows(content)[0].parts, [{ body: text }]); assert.doesNotMatch(content, /^\[\d+ characters omitted\]$/mu);
      assert.ok(Buffer.byteLength(content) <= 48 * 1024);
    }
    const shape = { batch_id: "edge", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "headings_shared_results" as const };
    let fitting = 0, maximum = 48 * 1024;
    while (fitting < maximum) {
      const middle = Math.ceil((fitting + maximum) / 2);
      if (/^- result:$/mu.test(formatRunCompletionBatchMessage({ ...shape, members: [item("edge", "A".repeat(middle))] }))) fitting = middle;
      else maximum = middle - 1;
    }
    for (const size of [fitting - 1, fitting, fitting + 1]) {
      const content = formatRunCompletionBatchMessage({ ...shape, members: [item("edge", "A".repeat(size))] });
      assert.match(content, size <= fitting ? /^- result:$/mu : /^- preview:$/mu);
      assert.ok(Buffer.byteLength(content) <= 48 * 1024);
      if (size === fitting) assert.equal(Buffer.byteLength(content), 48 * 1024);
    }
    const partial = item("guard", "A".repeat(64 * 1024)); let gets = 0;
    for (const value of [
      { ...partial.completion_text, text: "B" + partial.completion_text!.text.slice(1) },
      { text: "\ud800", shown_bytes: { start: 0, end: 3 } },
      { ...partial.completion_text, shown_bytes: { start: 1, end: 48 * 1024 } },
      Object.defineProperty({ ...partial.completion_text }, "text", { get() { gets++; throw Error("Must not read getter"); } }),
      Object.create(partial.completion_text!),
    ]) {
      assert.throws(() => admitRunCompletionBatch({ members: [{ ...partial, completion_text: value } as any], ownerId: "invalid-text", tempDir: root }), /Completion source text/);
      assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, "invalid-text")), false);
    }
    assert.equal(gets, 0);
    const upstream = item("upstream", "retained answer");
    upstream.primary_text = { output: { ...upstream.primary_text!.output!, text_basis: "actor_response", upstream_truncated: true } };
    const upstreamBatch = admitRunCompletionBatch({ members: [upstream], ownerId: "upstream", tempDir: root });
    assert.equal((coreRows(formatRunCompletionBatchMessage(upstreamBatch))[0].parts[0] as { body: string }).body, "retained answer");
    assert.match(formatRunCompletionBatchMessage(upstreamBatch), /\[omitted: unknown\] \(upstream completeness unproven\)/);
    assert.doesNotMatch(formatRunCompletionBatchMessage(upstreamBatch), /upstream_truncated:/mu);
    recordRunCompletionBatchDeliveryFailure({ batchId: upstreamBatch.batch_id, error: "retryable fixture failure", ownerId: "upstream", tempDir: root });
    assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "upstream").completion_batch!), projectRunCompletionBatchPresentation(upstreamBatch));
    const path = getRunDeliveryJournalPath(root, "upstream"), journal = JSON.parse(fs.readFileSync(path, "utf8"));
    delete journal.completion_batch.text_budget; const corrupt = JSON.stringify(journal); fs.writeFileSync(path, corrupt);
    assert.throws(() => readRunDeliveryJournal(root, "upstream"), /shared text budget is unavailable/);
    assert.equal(fs.readFileSync(path, "utf8"), corrupt);
    const unicode = "🚀".repeat(511) + "\r\n" + "界".repeat(18000);
    const text = "next/tool labels are opaque\r\n" + unicode;
    const batch = admitRunCompletionBatch({ members: [item("unicode", text)], ownerId: "unicode", tempDir: root });
    const frozen = batch.members[0]!.completion_text!;
    assert.equal(Buffer.from(frozen.text).toString("utf8"), frozen.text);
    assert.ok(text.startsWith(frozen.text)); assert.equal(frozen.text.endsWith("\r"), false);
    assert.match(projectRunCompletionBatchPresentation(batch).content, /^\[[1-9]\d* characters omitted\]$/mu);
    const crowd = admitRunCompletionBatch({ members: Array.from({length:64}, (_, i) => item("crowd-" + i, "Q".repeat(48 * 1024))), ownerId: "crowd", tempDir: root });
    assert.ok(Buffer.byteLength(formatRunCompletionBatchMessage(crowd)) <= 48 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(crowd)) <= 1024 * 1024);
    assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, "crowd").completion_batch!), projectRunCompletionBatchPresentation(crowd));
    assert.equal(Limits.RUN_DELIVERY_MODEL_MAX_BYTES, 16 * 1024, "Registry/Control/steer and retained codecs keep their separate limit");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Fresh outcome records never substitute launch metadata and retain explicit response coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-outcome-preview-"));
  try {
    const command = "LAUNCH_COMMAND_NOT_AN_ANSWER";
    const base = { ...member("outcome"), summary: "Run completed." }, binding = diagnosticBinding(base, command, "");
    const item = { ...base, ...binding, result_diagnostics: { ...binding.result_diagnostics, fields: ["command"] as const },
      diagnostic_excerpt: { ...binding.diagnostic_excerpt, field: "command" as const } };
    const retained = { presentation_format: "ax_records" as const, result_layout: "headings_flat_omissions" as const,
      navigation_handoff: "current_session_request" as const, batch_id: "outcome-codec", created_at: "2026-08-31T12:00:01.000Z",
      phase: "pending" as const, members: [item] };
    const old = projectRunCompletionBatchPresentation(retained);
    // Freeze the actual native-path wire bytes, including Windows JSON backslash escaping.
    assert.equal(createHash("sha256").update(old.content).digest("hex"), process.platform === "win32" ?
      "e18d4faa0e9fff5f6b796071e5cfc8b8ae525ad3488cbad8463067d8636d75f5" : "cc1251041d31c07361af00bad2c6f992727456addb538df6afa062de023628aa");
    assert.ok(old.content.includes(command));
    const packet = admitRunCompletionBatch({ members: [item], ownerId: "command", tempDir: root });
    const fresh = projectRunCompletionBatchPresentation(packet);
    assert.doesNotMatch(fresh.content, /LAUNCH_COMMAND_NOT_AN_ANSWER/);
    assert.match(fresh.content, /result_state: "not captured"/);
    assert.deepEqual(packet.members[0].diagnostic_excerpt, item.diagnostic_excerpt, "Stored diagnostics are not rewritten");
    assert.deepEqual(projectRunCompletionBatchPresentation(retained), old);
    const answer = { ...member("reply"), summary: "Run completed.",
      primary_text: primaryBinding(member("reply"), "ACTUAL ANSWER 🌍", "tail") };
    Object.assign(answer.primary_text.output, { text_basis: "actor_response", upstream_truncated: true });
    const projected = projectRunCompletionBatchPresentation(admitRunCompletionBatch({ members: [answer], ownerId: "reply", tempDir: root }));
    const shown = readRunCompletionPresentation(projected.content, projected.presentation)!.text;
    assert.equal(coreRows(projected.content)[0].metadata.kind, "primary"); assert.ok(shown.includes("ACTUAL ANSWER 🌍"));
    assert.match(shown, /\[omitted: unknown\] \(upstream completeness unproven\)/);
    assert.match(shown, /^\[4 characters omitted\]$/mu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX omitted counts are direct fields for fresh captures while saved heading packets keep exact replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-omitted-field-"));
  try {
    const members = omissionMembers("x".repeat(997));
    Object.assign(members[0], diagnosticBinding(members[0], "a", "x".repeat(997)));
    const retained = { presentation_format: "ax_records" as const, result_layout: "headings" as const,
      navigation_handoff: "current_session_request" as const, batch_id: "omitted-field-compat",
      created_at: "2026-08-31T12:00:01.000Z", phase: "pending" as const, members };
    const old = projectRunCompletionBatchPresentation(retained);
    assert.equal(createHash("sha256").update(old.content).digest("hex"), process.platform === "win32" ?
      "629ea7fea5a7bfbcbe036d99b483c2854515d7ee4ca2677faa3b6da3afbb7950" : "df5dace2e1b3f9d187f42d1e0ce0414b3e07ea853db80760461305c51b3a3c25");
    assert.equal((old.content.match(/^- omission: \[omitted: 997 chars\]$/gmu) ?? []).length, 2);
    const input = JSON.stringify(members);
    const batch = admitRunCompletionBatch({ members, batchId: retained.batch_id, now: new Date(retained.created_at), ownerId: "fresh", tempDir: root });
    const projected = projectRunCompletionBatchPresentation(batch);
    assert.equal((projected.content.match(/^\[997 characters omitted\]$/gmu) ?? []).length, 2);
    assert.doesNotMatch(projected.content, /^- omission: \[omitted:/mu);
    assert.doesNotMatch(projected.content, /secondary_diagnostic_excerpt/u);
    assert.match(readRunCompletionPresentation(projected.content, projected.presentation)!.text, /^\[997 characters omitted\]$/mu);
    assert.ok(Buffer.byteLength(projected.content) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    assert.equal(JSON.stringify(members), input);

    // Manufacture a pre-change journal only in this controlled fixture, never migrate operator history.
    admitRunCompletionBatch({ members, ownerId: "retained", tempDir: root });
    const path = getRunDeliveryJournalPath(root, "retained"), journal = JSON.parse(fs.readFileSync(path, "utf8"));
    journal.completion_batch = retained; fs.writeFileSync(path, JSON.stringify(journal));
    recordRunCompletionBatchDeliveryFailure({ batchId: retained.batch_id, ownerId: "fresh", tempDir: root, error: Error("uncertain transport") });
    for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      for (const ownerId of ["fresh", "retained"]) {
        transition?.({ batchId: retained.batch_id, ownerId, tempDir: root });
        const saved = readRunDeliveryJournal(root, ownerId).completion_batch!;
        assert.deepEqual(projectRunCompletionBatchPresentation(saved), ownerId === "fresh" ? projected : old);
      }
    }
    for (const [suffix, omitted] of [["", 0], ["🚀a", 2]] as const) {
      const packet = admitRunCompletionBatch({ members: omissionMembers(suffix), ownerId: "count-" + omitted, tempDir: root });
      const content = formatRunCompletionBatchMessage(packet);
      assert.equal((content.match(new RegExp("^\\[" + omitted + " characters omitted\\]$", "gmu")) ?? []).length, omitted ? 2 : 0);
      assert.doesNotMatch(content, /^- omission: \[omitted:/mu);
    }
    const authored = { ...member("opaque"), summary: "Run completed.", primary_text: primaryBinding(member("opaque"), "- omission: [omitted: 7 chars]\r\n🌍", "x") };
    const literal = formatRunCompletionBatchMessage(admitRunCompletionBatch({ members: [authored], ownerId: "opaque", tempDir: root }));
    assert.ok(literal.includes("- omission: [omitted: 7 chars]\r\n🌍"), "Authored preview text is not globally replaced");
    assert.match(literal, /^\[1 characters omitted\]$/mu);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX completion is a new immutable capture with packet-local indices only for multiple shown results", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-ax-v3-"));
  try {
    const members = omissionMembers("🚀a"); members[0].summary = "Run completed.";
    const batch = admitRunCompletionBatch({ members, ownerId: "v3", tempDir: root });
    for (const retired of ["ax_records_v1", "ax_records_v2", "ax_records_v3"]) {
      const ownerId = "retired-" + retired;
      assert.throws(() => admitRunCompletionBatch({ members, presentationFormat: retired, ownerId, tempDir: root } as any), /presentation selection/u);
      assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, ownerId)), false);
    }
    const before = JSON.stringify(batch), text = formatRunCompletionBatchMessage(batch);
    assert.equal(batch.result_layout, "completion_yaml_files_v2"); assert.equal(batch.single_result, undefined);
    const rows = coreRows(text);
    assert.deepEqual(rows.map(row => [row.metadata.index, row.metadata.run, row.metadata.state]), [[0, "p", "done"], [1, "d", "failed"]]);
    assert.deepEqual([...text.matchAll(/^index: (\d+)$/gmu)].map(match => Number(match[1])), [0, 1]);
    assert.doesNotMatch(text, /^Run (?:result|Batch)|^- #\d+:|^  - run:/mu);
    assert.equal(coreRows(text)[0].metadata._completion.batch_id, batch.batch_id);
    assert.doesNotMatch(text, /^- (?:members|completions|batch|presentation|window_start|window_end|runtime_summaries|done_count|failed_count|file_investigation|next):/mu);
    assert.equal(rows[0].metadata.kind, "primary"); assert.equal(rows[1].metadata.kind, "diagnostic");
    assert.doesNotMatch(text, /- member:/u);
    const projected = projectRunCompletionBatchPresentation(batch);
    assert.equal(batch.members[0].summary, "Run completed."); assert.doesNotMatch(text, /Run completed\./u);
    assert.deepEqual(rows[0].parts, [{ body: "🌍" }, { marker: "\n" }, { marker: "[2 characters omitted]" }]);
    const view = readRunCompletionPresentation(text, projected.presentation)!;
    assert.equal(view.compact, true); assert.equal(view.records, true); assert.equal(view.single, undefined);
    assert.doesNotMatch(view.text, /Run completed\.|(?:^|\n)  - technical:/u);
    assert.ok(view.text.includes('run: "' + members[0].run + '"'));
    assert.ok(rows[0].metadata.files);
    assert.ok(rootedEntries(rows[0].metadata).some(entry => entry.source && join(entry.root, entry.path) === members[0].primary_text!.output!.source.path));
    assert.ok(rootedEntries(rows[1].metadata).some(entry => entry.source && join(entry.root, entry.path) === members[1].result_diagnostics!.source.path));
    assert.equal(text.split("[2 characters omitted]").length - 1, 2);
    assert.equal(JSON.stringify(batch), before);
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition({ batchId: batch.batch_id, ownerId: "v3", tempDir: root });
      const saved = readRunDeliveryJournal(root, "v3").completion_batch!;
      assert.equal(saved.presentation_format, "ax_records"); assert.equal(formatRunCompletionBatchMessage(saved), text);
    }
    const single = admitRunCompletionBatch({ members: [members[0]], ownerId: "single-v3", tempDir: root });
    assert.equal(single.result_layout, "completion_yaml_files_v2"); assert.equal(single.single_result, undefined);
    assert.deepEqual([coreRows(formatRunCompletionBatchMessage(single))[0].metadata.index, coreRows(formatRunCompletionBatchMessage(single))[0].metadata.run], [undefined, "p"]);
    assert.doesNotMatch(formatRunCompletionBatchMessage(single), /(?:^|\n)\s*- (?:members|#0|completions):/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX singleton shape is captured once, stays flat across preview kinds and preserves exact recovery and whole omissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-single-"));
  try {
    const [primary, diagnostic] = omissionMembers("🚀a");
    primary.summary = "Run completed."; diagnostic.summary = "Run failed.";
    Object.assign(primary, diagnosticBinding(primary));
    const legacy = { ...member("legacy-single"), status: "killed" as const, summary: "Run killed.",
      output: "## Literal\r\n\r\n- completion: authored\n- presentation: ax_records\n- technical: opaque\n`````\nEND" };
    const missing = { ...member("missing-single"), artifacts: undefined, status: "exited" as const, summary: "Run exited.",
      primary_text: { output: null, output_unavailable: "source_unavailable" } as const,
      result_diagnostics: null, result_diagnostics_unavailable: "source_unavailable" };
    const malformed = { ...member("malformed-single"), summary: "Run completed.", output: "bad\ud800text" };
    for (const input of [primary, diagnostic, legacy, missing, malformed]) {
      const ownerId = input.run, expected = JSON.parse(JSON.stringify(input));
      const batch = admitRunCompletionBatch({ members: [input], fileNavigation: capturedLocations([input]), ownerId, tempDir: root });
      assert.equal(batch.result_layout, "completion_yaml_files_v2"); assert.equal(batch.single_result, undefined); assert.equal(batch.presentation_format, "ax_records");
      const projected = projectRunCompletionBatchPresentation(batch), content = projected.content;
      const view = readRunCompletionPresentation(content, projected.presentation)!;
      assert.equal(view.single, undefined); assert.equal(view.compact, true);
      const row = coreRows(content)[0];
      assert.equal(Object.hasOwn(row.metadata, "index"), false);
      assert.ok(view.segments!.filter(segment => segment.kind === "header").every(segment => !/^index:/mu.test(segment.text)));
      assert.equal(coreRows(content)[0].metadata._completion.batch_id, batch.batch_id);
      assert.deepEqual([row.metadata.run, row.metadata.state], [input.run, input.status]);
      assert.doesNotMatch(content, /^- completions:|^- members:|^  - #0:/mu);
      const location = { run: input.run, run_instance_id: input.run_instance_id, locations: batch.file_navigation![0].locations };
      assert.deepEqual(rootedNavigation(row.metadata), location); assert.ok(view.text.includes('run: "' + input.run + '"'));
      assert.ok(content.includes("files:\n"));  assert.ok(Buffer.byteLength(content) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
      for (const binding of [input.primary_text?.output?.source, input.result_diagnostics?.source]) if (binding) {
        assert.ok(rootedEntries(row.metadata).some(entry => entry.source && join(entry.root, entry.path) === binding.path)); assert.ok(content.includes(binding.sha256));
        assert.ok(content.includes(JSON.stringify(input.run_instance_id)));
      }
      if (input.primary_text?.output || input.diagnostic_excerpt) assert.ok(view.text.includes("[2 characters omitted]"));
      if (input === legacy) {
        assert.ok(view.text.includes(input.output!));
        assert.match(view.text, /\[omitted: unknown\] \(summary\/fallback text:/u);
      }
      if (input === missing) { assert.equal(row.metadata.primary_unavailable, "source_unavailable"); assert.equal(row.metadata.diagnostic_metadata_unavailable, "source_unavailable"); }
      if (input === malformed) {
        assert.match(view.text, /\[omitted: unknown\] \(malformed retained text\)/u);
        assert.doesNotMatch(content, /bad�text|\[omitted: 0 chars\]/u);
      }
      const snapshot = JSON.stringify(batch);
      recordRunCompletionBatchDeliveryFailure({ batchId: batch.batch_id, ownerId, tempDir: root, error: Error("transport uncertain") });
      for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        transition?.({ batchId: batch.batch_id, ownerId, tempDir: root });
        const saved = readRunDeliveryJournal(root, ownerId).completion_batch!;
        assert.equal(saved.result_layout, "completion_yaml_files_v2"); assert.equal(saved.single_result, undefined); assert.deepEqual(saved.members, [expected]);
        assert.deepEqual(projectRunCompletionBatchPresentation(saved), projected);
      }
      assert.equal(JSON.stringify(batch), snapshot);
      assert.throws(() => formatRunCompletionBatchMessage({ ...batch, single_result: false } as any), /singleton layout/u);
      assert.throws(() => formatRunCompletionBatchMessage({ ...batch, presentation_format: "ax_records_v3" }), /result layout/u);
      assert.throws(() => formatRunCompletionBatchMessage({ ...batch, single_result: true }), /result layout/u);
      assert.throws(() => formatRunCompletionBatchMessage({ ...batch, result_layout: "caller-choice" } as any), /result layout/u);
    }
    const huge = { ...member("huge-single"), summary: "Run completed.", artifacts: Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [String(i), "/WHOLE_" + i + "_" + "界".repeat(4087)])) };
    const omitted = admitRunCompletionBatch({ members: [huge], ownerId: "omitted", tempDir: root });
    const projected = projectRunCompletionBatchPresentation(omitted);
    assert.ok(omitted.inventory_source); assert.equal(coreRows(projected.content)[0].metadata._completion.service.omitted_results, 1);
    const inventory = JSON.parse(fs.readFileSync(omitted.inventory_source.path, "utf8"));
    assert.deepEqual(inventory.members.map((row: any) => [row.run, row.run_instance_id, row.status]), [[huge.run, huge.run_instance_id, huge.status]]);
    assert.doesNotMatch(projected.content, /WHOLE_|^- members_omitted:|^- completions:|^  - #0:/mu);
    assert.equal(readRunCompletionPresentation(projected.content, projected.presentation)!.compact, true);
    assert.ok(Buffer.byteLength(projected.content) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
    const small = { ...member("small"), artifacts: undefined };
    const failedHuge = { ...huge, status: "failed" as const, summary: "Run failed.",
      parent_run: small.run, parent_run_instance_id: small.run_instance_id, parent_state_dir: small.state_dir };
    // Topology keeps the shown parent first even when its stored member_index is 1.
    for (const members of [[small, failedHuge], [failedHuge, small]]) {
      const ownerId = "pair-" + members[0].run;
      const pair = admitRunCompletionBatch({ members, fileNavigation: capturedLocations(members), ownerId, tempDir: root });
      const snapshot = JSON.stringify(pair);
      const pairProjection = projectRunCompletionBatchPresentation(pair), pairView = readRunCompletionPresentation(pairProjection.content, pairProjection.presentation)!;
      assert.equal(pair.single_result, undefined); assert.equal(pairView.single, undefined);
      assert.equal(pair.result_layout, "completion_yaml_files_v2"); assert.equal(pairView.records, true);
      const rows = coreRows(pairProjection.content); assert.equal(rows.length, 1);
      assert.equal(Object.hasOwn(rows[0].metadata, "index"), false);
      assert.ok(pairView.segments!.filter(segment => segment.kind === "header").every(segment => !/^index:/mu.test(segment.text)));
      const service = rows[0].metadata._completion.service;
      assert.equal(service.omitted_results, 1); assert.deepEqual(service.omitted_states, { failed: 1 });
      assert.match(pairView.text, /delivery:\n  omitted_results: 1\n  omitted_states:\n    failed: 1/u);
      assert.equal(join(service.result_inventory.root, service.result_inventory.path), pair.inventory_source!.path);
      assert.equal(service.result_inventory.sha256, pair.inventory_source!.sha256);
      const inventory = JSON.parse(fs.readFileSync(pair.inventory_source!.path, "utf8"));
      assert.deepEqual(inventory.members.map((row: any) => [row.run, row.run_instance_id, row.status]),
        members.map(row => [row.run, row.run_instance_id, row.status]));
      assert.deepEqual(pair.members, JSON.parse(JSON.stringify(members)));
      assert.deepEqual(pair.file_navigation!.map(row => row.member_index), [0, 1]);
      assert.equal(rootedNavigation(rows[0].metadata).run_instance_id, small.run_instance_id);
      assert.deepEqual(rootedNavigation(rows[0].metadata).locations, pair.file_navigation![members.indexOf(small)].locations);
      for (const transition of [undefined, markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        transition?.({ batchId: pair.batch_id, ownerId, tempDir: root });
        assert.deepEqual(projectRunCompletionBatchPresentation(readRunDeliveryJournal(root, ownerId).completion_batch!), pairProjection);
      }
      assert.equal(JSON.stringify(pair), snapshot);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained AX UI ranges are content-bound compiler gaps, never authored headings, with pure full fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-v3-ranges-"));
  try {
    const opaque = "## Heading\r\n\r\n#1:\n- run: authored, not a record\n#0 result:\n- technical: body data\n- batch: not delivery\n  - tool: literal\n界😀 ````` source\nEND";
    const binding = primaryBinding(member("opaque"), "X" + opaque, "TAIL"), first = binding.output!;
    const m = { ...member("opaque"), artifacts: undefined, summary: "Run completed.", primary_text: { ...binding, output: {
      ...first, preview: opaque, shown_bytes: { start: 1, end: first.shown_bytes.end }, chars_shown: first.chars_shown - 1, chars_omitted: first.chars_omitted + 1 } } };
    // Historical V2 fixture, not a fresh capture relabeled with a legacy codec.
    const batch = { batch_id: "saved-ranges", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      presentation_format: "ax_records" as const, result_layout: "frontmatter_v2" as const, text_budget: 6000, members: [m] };
    const snapshot = JSON.stringify(batch), descriptors = Object.getOwnPropertyDescriptors(fs);
    const kill = Object.getOwnPropertyDescriptor(process, "kill")!, now = Object.getOwnPropertyDescriptor(Date, "now")!;
    const forbidden = () => assert.fail("A captured v3 projection cannot refresh evidence or native/time state");
    let projected: ReturnType<typeof projectRunCompletionBatchPresentation>;
    try {
      for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, { ...descriptors[key]!, value: forbidden });
      Object.defineProperty(process, "kill", { ...kill, value: forbidden }); Object.defineProperty(Date, "now", { ...now, value: forbidden }); syncBuiltinESMExports();
      projected = projectRunCompletionBatchPresentation(batch);
      assert.equal(projected.content, formatRunCompletionBatchMessage(batch));
    } finally {
      for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, descriptors[key]!);
      Object.defineProperty(process, "kill", kill); Object.defineProperty(Date, "now", now); syncBuiltinESMExports();
    }
    assert.equal(JSON.stringify(batch), snapshot);
    const { content, presentation } = projected!;
    assert.ok(presentation?.format !== "completion_yaml_core_v1");
    const view = readRunCompletionPresentation(content, presentation)!;
    assert.equal(view.compact, true); assert.equal(view.single, undefined);
    assert.ok(view.text.includes(opaque));
    assert.equal(view.text.includes(batch.batch_id), false); assert.ok(view.text.includes("- technical: body data"));
    assert.doesNotMatch(view.text, /- technical:\n  - window_start/u);
    assert.ok(content.includes(batch.batch_id)); assert.match(content, /^references: /mu);
    assert.doesNotMatch(content, /^- (?:window_start|window_end|runtime_summaries|file_investigation|next):/mu);
    const fallback = (hint: unknown) => assert.deepEqual(readRunCompletionPresentation(content, hint), { text: content, compact: false, records: true });
    for (const hint of [undefined, null, {}, { ...presentation, content_sha256: "0".repeat(64) }, { ...presentation, compact_ranges: [] },
      { ...presentation, compact_ranges: [[0, 2]] }, { ...presentation, compact_ranges: [[0, content.length + 1]] },
      { ...presentation, compact_ranges: [[0, 10], [9, 20]] }, { ...presentation, compact_ranges: presentation!.compact_ranges.slice(0, -1) }]) fallback(hint);
    const pair = content.indexOf("😀"), crlf = content.indexOf("\r\n");
    for (const end of [pair + 1, crlf + 1]) fallback({ ...presentation, compact_ranges: [[0, end]] });
    const authored = content.indexOf("- technical: body data"), gapStart = content.lastIndexOf("\n", authored), gapEnd = content.indexOf("\n", authored);
    const bodyRange = presentation!.compact_ranges.findIndex(([a, b]) => a < gapStart && b > gapEnd);
    assert.ok(bodyRange >= 0);
    const [a, b] = presentation!.compact_ranges[bodyRange]!;
    fallback({ ...presentation, compact_ranges: [...presentation!.compact_ranges.slice(0, bodyRange), [a, gapStart], [gapEnd + 1, b], ...presentation!.compact_ranges.slice(bodyRange + 1)] });
    let getterReads = 0;
    const getter = Object.defineProperty({ ...presentation }, "compact_ranges", { get() { getterReads++; throw Error("not data"); } });
    fallback(getter); assert.equal(getterReads, 0);
    assert.deepEqual(readRunCompletionPresentation(content + "changed", presentation), { text: content + "changed", compact: false, records: true });
    const old = { ...batch, text_budget: undefined, result_layout: undefined, single_result: undefined, presentation_format: "ax_records_v2" as const };
    assert.equal(projectRunCompletionBatchPresentation(old).presentation, undefined);
    assert.equal(readRunCompletionPresentation(formatRunCompletionBatchMessage(old), undefined), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX bounds omit whole rows/references and retain correct displayed-index generation bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-v3-bounds-"));
  try {
    const members = Array.from({ length: 65 }, (_, i) => ({ ...member(`r${i}`), run_instance_id: "g", artifacts: undefined, summary: "Run completed." }));
    const batch = admitRunCompletionBatch({ members, ownerId: "cap", tempDir: root });
    const text = formatRunCompletionBatchMessage(batch);
    assert.equal(coreRows(text).filter(row => row.metadata.run !== undefined).length, 64); assert.equal(coreRows(text)[0].metadata._completion.service.omitted_results, 1); assert.ok(batch.inventory_source);
    const last = formatRunCompletionBatchMessage({ ...batch, members: [members[64]!], inventory_source: undefined });
    assert.ok(Buffer.byteLength(text) + Buffer.byteLength(last) < Limits.RUN_COMPLETION_MODEL_MAX_BYTES, "A whole extra single-member packet fits: omission is the independent row cap");
    const parent = { ...member("parent"), artifacts: undefined }, child = { ...member("child"), artifacts: undefined,
      parent_run: parent.run, parent_run_instance_id: parent.run_instance_id, parent_state_dir: parent.state_dir };
    const input = [child, parent];
    const located = admitRunCompletionBatch({ members: input, fileNavigation: capturedLocations(input).reverse(), ownerId: "locations", tempDir: root });
    const complete = formatRunCompletionBatchMessage(located);
    assert.deepEqual(coreRows(complete).map(row => [row.metadata.index, row.metadata.run]), [[0, "parent"], [1, "child"]]);
    for (const row of located.file_navigation!) {
      const m = located.members[row.member_index]!;
      assert.deepEqual(rootedNavigation(coreRows(complete).find(record => record.metadata.run === m.run)!.metadata), { run: m.run, run_instance_id: m.run_instance_id, locations: row.locations });
    }
    const verbose = Array.from({ length: 10 }, (_, i) => ({ ...member(`budget${i}`), artifacts: undefined, summary: "Run completed.", output: "x".repeat(4000) }));
    const limited = admitRunCompletionBatch({ members: verbose, fileNavigation: capturedLocations(verbose), ownerId: "limited-refs", tempDir: root });
    const limitedText = formatRunCompletionBatchMessage(limited);
    assert.equal(limitedText.includes("members_omitted"), false);
    const limitedRows = coreRows(limitedText);
    const shown = limitedRows.filter(row => rootedNavigation(row.metadata) !== undefined).length;
    assert.ok(shown > 0 && shown < verbose.length);
    assert.equal(limitedRows.filter(row => row.metadata.run_files_omission?.omitted === 1).length, verbose.length - shown);
    for (const [index, row] of limited.file_navigation!.entries()) {
      const m = limited.members[row.member_index]!;
      const reference = { run: m.run, run_instance_id: m.run_instance_id, locations: row.locations };
      assert.deepEqual(rootedNavigation(limitedRows.find(record => record.metadata.run === m.run)!.metadata), index < shown ? reference : undefined, "References fit whole or are omitted, never sliced or rebound");
    }
    assert.ok(Buffer.byteLength(limitedText) <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES);
    const exactMember = (n: number) => ({ ...member("edge"), summary: "Run completed.", artifacts: { a: "/a" + "x".repeat(3998), b: "/b" + "x".repeat(3998), c: "/c" + "x".repeat(3998), d: "/d" + "x".repeat(n) } });
    const feedbackShape = { result_layout: "headings" as const, presentation_format: "ax_records" as const, batch_id: "feedback",
      created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const };
    const smallLast = { ...member("last"), artifacts: undefined, summary: "Run completed." };
    let fitting = 0, maximum = 4094;
    while (fitting < maximum) {
      const middle = Math.ceil((fitting + maximum) / 2);
      const value = formatRunCompletionBatchMessage({ ...feedbackShape, members: [exactMember(middle), smallLast] });
      if (value.includes("\n\n#1:")) fitting = middle; else maximum = middle - 1;
    }
    const full = formatRunCompletionBatchMessage({ ...feedbackShape, members: [exactMember(fitting), smallLast] });
    assert.equal(Buffer.byteLength(full), Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const firstEnd = full.indexOf("\n\n#1:"), marker = readRunCompletionRecordMarker(full)!;
    assert.ok(firstEnd > 0);
    const misleadingPrefix = full.slice(0, firstEnd) + "\n- omitted_results: 1\n- inventory_warning: No inventory reference is retained in this packet." + full.slice(marker.start);
    assert.ok(Buffer.byteLength(misleadingPrefix) > Limits.RUN_DELIVERY_MODEL_MAX_BYTES, "A nonfitting partial prefix must not hide a fitting complete result list");
    const admitted = admitRetainedFixture({ presentationFormat: "ax_records", resultLayout: "headings", batchId: "feedback", members: [exactMember(fitting), smallLast], ownerId: "feedback", tempDir: root });
    assert.equal(admitted.inventory_source, undefined); assert.equal(formatRunCompletionBatchMessage(admitted), full);
    for (const captured of [{}, { single_result: true as const }, { result_layout: "records" as const }, { result_layout: "run_headers" as const }, { result_layout: "headings" as const }, { result_layout: "headings_flat_omissions" as const }, { result_layout: "headings_outcomes" as const }]) {
      const shape = { ...captured, presentation_format: "ax_records" as const, batch_id: "edge", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const };
      const omitted = (value: string) => (captured.result_layout === "headings" || captured.result_layout === "headings_flat_omissions" || captured.result_layout === "headings_outcomes" || captured.result_layout === "run_headers") ? value.includes("- omitted_results: 1") : "single_result" in captured || "result_layout" in captured ? value.includes("- result: omitted (model byte limit)") : value.includes("- members_omitted: 1");
      let low = 0, high = 4094;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2), value = formatRunCompletionBatchMessage({ ...shape, members: [exactMember(mid)] });
        if (omitted(value)) high = mid - 1; else low = mid;
      }
      assert.ok(low < 4094);
      const edge = formatRunCompletionBatchMessage({ ...shape, members: [exactMember(low)] });
      assert.equal(Buffer.byteLength(edge), Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
      assert.ok(edge.includes(exactMember(low).artifacts.d));
      const over = formatRunCompletionBatchMessage({ ...shape, members: [exactMember(low + 1)] });
      assert.ok(omitted(over)); assert.ok(!over.includes(exactMember(low + 1).artifacts.d));
      assert.ok(Buffer.byteLength(over) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX preserves selected legacy boundaries and unavailable sources without repairing malformed text", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-v3-loss-"));
  try {
    const m = { ...member("loss"), artifacts: undefined, summary: "x".repeat(198) + "😀TAIL", output: "bad\ud800text",
    };
    const missing = { ...member("missing"), artifacts: undefined, summary: "Run completed.",
      primary_text: { output: null, output_unavailable: "source_unavailable" } as const,
      artifact_inventory: null, artifact_inventory_unavailable: "source_unavailable", result_diagnostics: null, result_diagnostics_unavailable: "source_unavailable" };
    const batch = admitRunCompletionBatch({ members: [m, missing], ownerId: "loss", tempDir: root });
    const before = JSON.stringify(batch), projected = projectRunCompletionBatchPresentation(batch);
    assert.equal((coreRows(projected.content)[0].parts[0] as { body: string }).body, "x".repeat(198)); assert.equal(projected.content.includes("TAIL"), false);
    assert.match(projected.content, /\[omitted: unknown\] \(malformed retained text\)/u);
    assert.equal(coreRows(projected.content)[1].metadata.primary_unavailable, "source_unavailable");
    assert.equal(coreRows(projected.content)[1].metadata.artifact_inventory_unavailable, "source_unavailable");
    assert.equal(coreRows(projected.content)[1].metadata.diagnostic_metadata_unavailable, "source_unavailable");
    assert.doesNotMatch(projected.content, /bad�text|\[omitted: 0 chars\]/u);
    assert.equal(JSON.stringify(batch), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained draft completion codecs keep their frozen byte fingerprints", () => {
  const recentSingle = { presentation_format: "ax_records" as const, single_result: true as const, navigation_handoff: "current_session_request" as const,
    batch_id: "fixture-only-capture", created_at: "2026-10-29T08:00:01.000Z", phase: "pending" as const,
    members: [{ run: "a", run_instance_id: "generation-a", state_dir: "/fixture/runs/a", status: "done" as const, summary: "Run completed.",
      output: "Fixture answer.", terminal_at: "2026-10-29T08:00:00.000Z" }] };
  assert.equal(createHash("sha256").update(formatRunCompletionBatchMessage(recentSingle)).digest("hex"), "29960859cffc14c3159524cfb0db27ec9bd09b95281b105bdd35ff263e9cc595");
  const { single_result: _single, ...recordsBase } = recentSingle;
  const recordHashes = ["aafc8bb24e17048e7e8f8f8ac0cda0efbc79ec74da7c8dba62f970bbb8a99a8d", "01fe2eb957243fd47d866a610e3e279db9fcaeb247d5e23f45de5111bd75af1b"];
  const recordRanges = [[[0, 8], [9, 22], [23, 45], [46, 56], [67, 84], [91, 187]],
    [[0, 5], [6, 16], [17, 32], [33, 57], [58, 70], [83, 102], [111, 209], [210, 215], [216, 226], [227, 244], [245, 269], [270, 282], [295, 314], [323, 421]]];
  const headerHashes = ["d084a23a132b82684d5ad624909b25d2710a5db9b76dd175b4a0f63479544258", "5a836971bd497e9ed543e9d94dbee693f7e6b0c2fc6dadb205dd5e2d2289b1f9"];
  const headerRanges = [[[0, 7], [8, 16], [17, 30], [31, 53], [54, 64], [75, 92], [99, 195]],
    [[0, 7], [8, 16], [17, 30], [31, 53], [54, 64], [75, 92], [99, 195], [196, 204], [205, 213], [214, 229], [230, 252], [253, 263], [274, 291], [298, 394]]];
  for (const result_layout of ["records", "run_headers"] as const) for (const [index, members] of [[recentSingle.members[0]], [recentSingle.members[0], { ...recentSingle.members[0], run: "b", run_instance_id: "generation-b", state_dir: "/fixture/runs/b", status: "failed" as const, summary: "Run failed." }]].entries()) {
    const captured = { ...recordsBase, result_layout, members };
    const projected = projectRunCompletionBatchPresentation(captured);
    assert.equal(createHash("sha256").update(projected.content).digest("hex"), (result_layout === "records" ? recordHashes : headerHashes)[index]);
    assert.ok(projected.presentation?.format !== "completion_yaml_core_v1");
    assert.deepEqual(projected.presentation!.compact_ranges, (result_layout === "records" ? recordRanges : headerRanges)[index]);
    for (const phase of ["pending", "queued", "presented"] as const) assert.deepEqual(projectRunCompletionBatchPresentation({ ...captured, phase,
      ...(phase !== "pending" ? { queued_at: "2026-10-29T08:00:02.000Z" } : {}), ...(phase === "presented" ? { presented_at: "2026-10-29T08:00:02.000Z" } : {}) }), projected);
  }
  const expected = ["bed992526009b1141be4826b48e7ef6628039df8e8c4aa36a3a6ce71ad5b99aa", "bc884063faa26ae08d842deab8c600df9338f7555d066a59220c807cee0ba916", "7357382e7dfe15014fcd907b09b20c56912122351d69e85cb86820ef5a770057"];
  for (const [index, members] of [[member("stable")], [member("stable"), member("peer")], [member("stable"), { ...member("peer"), status: "failed" as const }]].entries()) {
    const batch = { presentation_format: "ax_records_v2" as const, navigation_handoff: "current_session_request" as const,
      batch_id: "ax-v2-frozen", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const, members };
    assert.equal(createHash("sha256").update(formatRunCompletionBatchMessage(batch)).digest("hex"), expected[index]);
    const recordExpected = ["8488d79625ea2545deaa29db7b4ce6711059fc5723386d2ef96c9b59ce409685", "183ee0c55f87ce91ef921e6c6c6e69b7f0b594eee76684679e47e3a0d00f9eba", "8e5db2d7f365a972e70617576d4e8b9e7ddf8f411f5bf79f3a8830dd9fb1286f"];
    const retained = { ...batch, presentation_format: "ax_records_v3" as const, batch_id: "draft-records-frozen" };
    assert.equal(createHash("sha256").update(formatRunCompletionBatchMessage(retained)).digest("hex"), recordExpected[index]);
    const canonicalExpected = ["2fd0a269d7fd871456c44b7c304e9e678222739c563821a7c761f126f50be41c", "51930bbedd194740281fccb98ee7c6d110b2f62c43779dd6c51cbdaccf0d1824", "ef02334bb86bd351df3cf11cea6a6e96f49aca3fc610c1a17fb86e7986f886d9"];
    const canonical = { ...batch, presentation_format: "ax_records" as const, batch_id: "canonical-records-frozen" };
    assert.equal(createHash("sha256").update(formatRunCompletionBatchMessage(canonical)).digest("hex"), canonicalExpected[index]);
    const inherited = Object.assign(Object.create({ single_result: true }), canonical);
    assert.equal(formatRunCompletionBatchMessage(inherited), formatRunCompletionBatchMessage(canonical));
    for (const result_layout of ["records", "run_headers", "headings", "headings_flat_omissions", "headings_outcomes"]) assert.equal(formatRunCompletionBatchMessage(Object.assign(Object.create({ result_layout }), canonical)), formatRunCompletionBatchMessage(canonical));
    let layoutReads = 0;
    const layoutAccessor = Object.defineProperty({ ...canonical }, "result_layout", { get() { layoutReads++; return "records"; } });
    assert.throws(() => formatRunCompletionBatchMessage(layoutAccessor), /result layout/u); assert.equal(layoutReads, 0);
    let reads = 0;
    const accessor = Object.defineProperty({ ...canonical }, "single_result", { get() { reads++; return true; } });
    assert.throws(() => formatRunCompletionBatchMessage(accessor), /singleton layout/u); assert.equal(reads, 0);
  }
});

test("Retained draft summary/count layouts keep their exact captured bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-ax-v2-"));
  try {
    const expected = ["9a4a9bfed249bba338cdb90b3e080e480287eff1ee0ac4b9cb159b5fef7d71e9", "d25943954378f8a8eeeeb49b45813118b653488e5f271ad2885079cbd7bf5ebb", "fba0e242a80eeb5c634925fbf5077b262b583b8fb8d39c3ae7554aaaffc92baa"];
    for (const [index, members] of [[member("stable")], [member("stable"), member("peer")], [member("stable"), { ...member("peer"), status: "failed" as const }]].entries()) {
      const v1 = { presentation_format: "ax_records_v1" as const, navigation_handoff: "current_session_request" as const,
        batch_id: "ax-v1-frozen", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const, members };
      assert.equal(createHash("sha256").update(formatRunCompletionBatchMessage(v1)).digest("hex"), expected[index]);
    }
    const members = omissionMembers("🚀a");
    const batch = admitRetainedFixture({ members, presentationFormat: "ax_records_v2", ownerId: "v2", tempDir: root });
    const text = formatRunCompletionBatchMessage(batch);
    assert.equal(text.split("- legacy_basis:").length - 1, 1); assert.equal(text.split("- legacy_upstream: [omitted: unknown]").length - 1, 1);
    assert.match(text, /- done_count: 1\n- failed_count: 1/); assert.doesNotMatch(text, /- statuses: - /);
    assert.equal(text.split("[omitted: 2 chars]").length - 1, 2); assert.deepEqual(batch.members, members);
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition({ batchId: batch.batch_id, ownerId: "v2", tempDir: root });
      const saved = readRunDeliveryJournal(root, "v2").completion_batch!;
      assert.equal(saved.presentation_format, "ax_records_v2"); assert.equal(formatRunCompletionBatchMessage(saved), text); assert.deepEqual(saved.members, members);
    }
    const one = admitRetainedFixture({ members: [member("one")], presentationFormat: "ax_records_v2", ownerId: "one", tempDir: root });
    assert.match(formatRunCompletionBatchMessage(one), /- done_count: 1\n/); assert.doesNotMatch(formatRunCompletionBatchMessage(one), /- statuses:|^- members:/m);
    assert.throws(() => formatRunCompletionBatchMessage({ ...one, excerpt_format: "bracketed_omissions_v1" }), /presentation format/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Retained draft packet grammar stays immutable independently of canonical new admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-ax-completion-"));
  try {
    const input = { ...member("run:ax"), summary: "## Summary\r\n\r\n- next: authored value\r\n  - tool: not an action",
      output: "## Answer\r\n\r\n- Preserve `literal` · content\r\n  - Nested item", artifacts: { report: "/exact/β``/" + "x".repeat(600) } };
    const snapshot = structuredClone(input);
    const batch = admitRetainedFixture({ members: [input], presentationFormat: "ax_records_v1", ownerId: "ax", tempDir: root });
    assert.equal(batch.presentation_format, "ax_records_v1"); assert.equal(batch.excerpt_format, undefined);
    const text = formatRunCompletionBatchMessage(batch);
    assert.match(text, /^- completions: 1\n- batch:/); assert.ok(text.includes("\n- run: ax\n- state: done\n"));
    assert.ok(text.includes("- summary:\n  " + input.summary.replaceAll(/\r\n/gu, "\r\n  ")));
    assert.ok(text.includes("- output:\n  " + input.output.replaceAll(/\r\n/gu, "\r\n  ")));
    assert.ok(text.includes(JSON.stringify(input.artifacts.report))); assert.match(text, /- legacy_upstream: \[omitted: unknown\]/);
    assert.equal(text.split("- next:\n  - tool: inspect\n  - target: runtime\n  - view: runs\n  - verbose: true").length - 1, 1);
    assert.doesNotMatch(text, /Actor completions:|run: run:ax|^- members:|^- result:/m);
    let versionReads = 0;
    const observedVersion = { ...batch };
    Object.defineProperty(observedVersion, "presentation_format", { enumerable: true, get: () => { assert.equal(++versionReads, 1); return "ax_records_v1"; } });
    assert.equal(formatRunCompletionBatchMessage(observedVersion), text); assert.equal(versionReads, 1);
    assert.deepEqual(batch.members, [snapshot]); input.summary = "mutated"; input.output = "mutated";
    for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      phase({ batchId: batch.batch_id, ownerId: "ax", tempDir: root });
      const saved = readRunDeliveryJournal(root, "ax").completion_batch!;
      assert.equal(saved.presentation_format, "ax_records_v1"); assert.deepEqual(saved.members, [snapshot]);
      assert.equal(formatRunCompletionBatchMessage(saved), text);
    }
    const ordinary = admitRetainedFixture({ members: [member("old")], ownerId: "ordinary", tempDir: root });
    assert.equal(ordinary.presentation_format, undefined); assert.equal(ordinary.excerpt_format, "bracketed_omissions_v1");
    assert.match(formatRunCompletionBatchMessage(ordinary), /^Actor completions:/);
    for (const invalid of [null, false, true, "", "other", {}]) assert.throws(() => formatRunCompletionBatchMessage({ ...batch, presentation_format: invalid } as any), /presentation format/);
    assert.throws(() => formatRunCompletionBatchMessage({ ...batch, excerpt_format: "bracketed_omissions_v1" }), /presentation format/);
    assert.throws(() => admitRunCompletionBatch({ members: [member("bad")], ownerId: "bad", tempDir: root, presentationFormat: "bad" } as any), /presentation selection/);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(root, "bad")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX completion excerpts keep exact tracked ranges and opaque sources while legacy loss stays unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-ax-excerpts-"));
  try {
    const members = omissionMembers("🚀a");
    members[0].primary_text = primaryBinding(members[0], " \uFEFF\r\n🌍````  \r\n", "🚀a");
    Object.assign(members[1], diagnosticBinding(members[1], "\r\n界\uFFFD````\n", "🚀a"));
    const original = structuredClone(members);
    const batch = admitRetainedFixture({ members, ownerId: "ax", tempDir: root, presentationFormat: "ax_records_v1" });
    const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const kill = process.kill, now = Date.now, forbidden = () => assert.fail("AX rendering cannot refresh IO/native/time");
    Object.assign(fs, { readFileSync: forbidden, readdirSync: forbidden, statSync: forbidden, lstatSync: forbidden }); process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
    let text: string;
    try { text = formatRunCompletionBatchMessage(batch); }
    finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
    assert.equal(text.split("[omitted: 2 chars]").length - 1, 2); assert.doesNotMatch(text, /\[omitted: 3 chars\]|characters omitted/);
    assert.ok(text.includes("Diagnostic metadata only; not primary output; admission privacy for recorded fields."));
    for (const source of [members[0].primary_text!.output!.source, members[1].result_diagnostics!.source]) assert.ok(text.includes(JSON.stringify(source.path)));
    assert.ok(text.includes("🌍")); assert.ok(text.includes("界")); assert.ok(text.includes("\uFEFF")); assert.ok(text.includes("\uFFFD"));
    assert.match(text, /\n\s+`{5}text\n/); assert.match(text, /\n\s+`{5}\n\s+…\n/);
    assert.deepEqual(batch.members, original);
    const complete = admitRetainedFixture({ members: omissionMembers(""), ownerId: "complete", tempDir: root, presentationFormat: "ax_records_v1" });
    const completeText = formatRunCompletionBatchMessage(complete); assert.doesNotMatch(completeText, /\[omitted: 0 chars\]/);
    // Controlled admitted ranges test layout only; this does not adopt new primary-source selection.
    for (const [head, tail] of [["H", ""], ["", "T"], ["H", "T"]]) {
      const item = { ...member("ranged"), artifacts: undefined }, preview = "🌍";
      const binding = primaryBinding(item, preview, head + tail);
      const ranged = { ...binding, output: { ...binding.output,
        source: { ...binding.output.source, sha256: createHash("sha256").update(head + preview + tail).digest("hex") },
        shown_bytes: { start: Buffer.byteLength(head), end: Buffer.byteLength(head + preview) } } };
      const packet = admitRetainedFixture({ members: [{ ...item, primary_text: ranged }], ownerId: "range-" + head + tail, tempDir: root, presentationFormat: "ax_records_v1" });
      const rendered = formatRunCompletionBatchMessage(packet);
      assert.ok(rendered.includes("- preview:\n    " + (head ? "…\n    " : "") + "```text\n    🌍\n    ```" + (tail ? "\n    …" : "")));
      assert.ok(rendered.includes(`[omitted: ${head.length + tail.length} chars]`)); assert.deepEqual(packet.members[0].primary_text, ranged);
    }
    const clipped = admitRetainedFixture({ members: [{ ...member("legacy"), summary: "x".repeat(198) + "😀TAIL" }], ownerId: "legacy", tempDir: root, presentationFormat: "ax_records_v1" });
    const clippedText = formatRunCompletionBatchMessage(clipped);
    assert.ok(clippedText.includes("- summary: " + "x".repeat(198) + "…\n- summary_omission: [omitted: unknown]"));
    assert.equal(Buffer.from(clippedText).toString("utf8"), clippedText); assert.equal(clipped.members[0].summary, "x".repeat(198) + "😀TAIL");
    assert.doesNotMatch(clippedText, /\[omitted: \d+ chars\]/u);
    const unavailable = admitRetainedFixture({ members: [{ ...member("missing"), artifacts: undefined, primary_text: { output: null, output_unavailable: "source_unavailable" },
      artifact_inventory: null, artifact_inventory_unavailable: "source_unavailable", result_diagnostics: null, result_diagnostics_unavailable: "source_unavailable" }], ownerId: "missing", tempDir: root, presentationFormat: "ax_records_v1" });
    const missingText = formatRunCompletionBatchMessage(unavailable);
    assert.equal(missingText.split("- state: unavailable").length - 1, 3); assert.ok(missingText.includes("no legacy body fallback")); assert.ok(missingText.includes("no legacy path fallback"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("AX completion bounds retain whole members and references with exact captured-inventory recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-ax-bounds-"));
  try {
    const members = Array.from({ length: 65 }, (_, index) => ({ ...member(`r${index}`), artifacts: undefined, summary: "R" }));
    const batch = admitRetainedFixture({ members, ownerId: "ax", tempDir: root, presentationFormat: "ax_records_v1" });
    const text = formatRunCompletionBatchMessage(batch); assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    assert.equal(text.match(/^    - run:/gm)!.length, 64); assert.match(text, /- members_omitted: 1/);
    const minimal = formatRunCompletionBatchMessage({ ...batch, members: [members[64]], inventory_source: undefined });
    assert.ok(Buffer.byteLength(text) + Buffer.byteLength(minimal) + 256 < Limits.RUN_DELIVERY_MODEL_MAX_BYTES, "Even a whole extra record plus conservative list overhead fits: the64row cap, not bytes, excludes member65");
    const source = batch.inventory_source!; assert.ok(text.includes(JSON.stringify(source.path)));
    const bytes = fs.readFileSync(source.path); assert.equal(bytes.length, source.bytes_total); assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
    const inventory = JSON.parse(bytes.toString("utf8")); assert.deepEqual(inventory.members.map((item: RunCompletionBatchMember) => item.run), members.map(item => item.run));
    assert.equal(inventory.private_locations, "not_included"); assert.equal(inventory.artifacts, "not_included"); assert.equal(inventory.diagnostics, "not_included");
    fs.unlinkSync(source.path);
    markRunCompletionBatchQueued({ batchId: batch.batch_id, ownerId: "ax", tempDir: root });
    assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(root, "ax").completion_batch!), text);
    const paths = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [String(i), "/WHOLE_REF_" + String(i).repeat(4080)]));
    const huge = admitRetainedFixture({ members: [{ ...member("huge"), artifacts: paths }], ownerId: "huge", tempDir: root, presentationFormat: "ax_records_v1" });
    const hugeText = formatRunCompletionBatchMessage(huge); assert.ok(Buffer.byteLength(hugeText) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    assert.match(hugeText, /- members_omitted: 1/); assert.doesNotMatch(hugeText, /WHOLE_REF_/); assert.deepEqual(huge.members[0].artifacts, paths);
    const small = member("small"), smallLocations = capturedLocations([small]);
    const one = admitRetainedFixture({ members: [small], fileNavigation: smallLocations, ownerId: "one", tempDir: root, presentationFormat: "ax_records_v1" });
    const oneText = formatRunCompletionBatchMessage(one);
    assert.ok(oneText.includes(JSON.stringify({ run: small.run, run_instance_id: small.run_instance_id, locations: one.file_navigation![0].locations })));
    assert.match(oneText, /- run_files:\n  - shown: 1\n  - omitted: 0\n  - total: 1/);
    const boundaryMember = { ...member("boundary"), artifacts: { a: "a".repeat(4090), b: "b".repeat(4090), c: "c".repeat(4090), d: "/" } };
    const boundary = { ...one, navigation_handoff: undefined, file_navigation: undefined, inventory_source: undefined, members: [boundaryMember] };
    const padding = Limits.RUN_DELIVERY_MODEL_MAX_BYTES - Buffer.byteLength(formatRunCompletionBatchMessage(boundary));
    assert.ok(padding > 0 && padding < 4094);
    const exactPath = "/" + "x".repeat(padding);
    const exact = formatRunCompletionBatchMessage({ ...boundary, members: [{ ...boundaryMember, artifacts: { ...boundaryMember.artifacts, d: exactPath } }] });
    assert.equal(Buffer.byteLength(exact), Limits.RUN_DELIVERY_MODEL_MAX_BYTES); assert.ok(exact.includes(JSON.stringify(exactPath)));
    const over = formatRunCompletionBatchMessage({ ...boundary, members: [{ ...boundaryMember, artifacts: { ...boundaryMember.artifacts, d: exactPath + "x" } }] });
    assert.match(over, /- members_omitted: 1/); assert.ok(!over.includes(exactPath)); assert.ok(Buffer.byteLength(over) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const forest = Array.from({ length: 40 }, (_, index) => ({ ...member(`work-${index}`), summary: "s".repeat(180), state_dir: join(root, "controlled", `work-${index}`) }));
    const fileNavigation = capturedLocations(forest.slice(0, 5));
    const located = admitRetainedFixture({ members: forest, fileNavigation, ownerId: "locations", tempDir: root, presentationFormat: "ax_records_v1" });
    const locationText = formatRunCompletionBatchMessage(located); assert.ok(Buffer.byteLength(locationText) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const counts = /- run_files:\n  - shown: (\d+)\n  - omitted: (\d+)\n  - total: (\d+)/.exec(locationText)!; assert.ok(counts);
    const shown = Number(counts[1]); assert.ok(shown >= 0 && shown < fileNavigation.length); assert.equal(shown + Number(counts[2]), forest.length); assert.equal(Number(counts[3]), forest.length);
    for (const [index, row] of fileNavigation.entries()) assert.equal(locationText.includes(JSON.stringify({ run: forest[index].run, run_instance_id: forest[index].run_instance_id, locations: located.file_navigation![index].locations })), index < shown);
    assert.deepEqual(located.file_navigation, fileNavigation);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("New tracked excerpts disclose exact bracketed code-point omissions without changing retained text or sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-bracketed-omissions-"));
  try {
    const members = omissionMembers("🚀a");
    const batch = admitRetainedFixture({ members, ownerId: "owner", tempDir: root });
    assert.equal(Reflect.get(batch, "excerpt_format"), "bracketed_omissions_v1");
    const text = formatRunCompletionBatchMessage(batch);
    assert.equal(text.split("[2 characters omitted]").length - 1, 2, "Unicode points, not UTF-16 units or UTF-8 bytes");
    assert.doesNotMatch(text, /\[3 characters omitted\]|code points; 2 omitted/);
    assert.deepEqual(batch.members, members);
    assert.ok(text.includes("🌍")); assert.ok(text.includes("界"));
    assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      phase({ batchId: batch.batch_id, ownerId: "owner", tempDir: root });
      const saved = readRunDeliveryJournal(root, "owner").completion_batch!;
      assert.equal(Reflect.get(saved, "excerpt_format"), "bracketed_omissions_v1");
      assert.equal(formatRunCompletionBatchMessage(saved), text);
      assert.deepEqual(saved.members, members);
    }
    for (const invalid of [null, false, true, "", "other", {}]) {
      const malformed = { ...batch };
      Reflect.set(malformed, "excerpt_format", invalid);
      assert.throws(() => formatRunCompletionBatchMessage(malformed), /excerpt format/);
    }
    const complete = admitRetainedFixture({ members: omissionMembers(""), ownerId: "complete", tempDir: root });
    assert.equal(formatRunCompletionBatchMessage(complete).split("[0 characters omitted]").length - 1, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("All three pre-marker packet formats retain their pre-change rendering fingerprints through journal phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-legacy-omission-formats-"));
  const expected = ["fb55bdd8a5c955dd07e12d23ec4408486446959e28c2be7e0dd60f78b815f6cf", "7d71e381e6cedb2aeb2166b160cea07c4bcbee0d00dea76576e456bc882626c2", "baf9fce821cce54a36ac05563be948957bec0746a3e4cb7e4a6a5c450f07e06a"];
  try {
    for (const [index, navigation_handoff] of ([undefined, "current_session_request", "captured_file_locations"] as const).entries()) {
      const legacy = { batch_id: "legacy-omissions", created_at: "2026-08-31T12:00:00.000Z", members: omissionMembers(), phase: "pending" as const,
        ...(navigation_handoff ? { navigation_handoff } : {}), ...(navigation_handoff === "captured_file_locations" ? { file_navigation: [] } : {}) };
      const text = formatRunCompletionBatchMessage(legacy);
      let normalized = text;
      for (const source of [legacy.members[0]!.primary_text!.output!.source, legacy.members[1]!.result_diagnostics!.source]) {
        assert.ok(text.includes(JSON.stringify(source.path)), "Full exact source paths remain visible");
        normalized = normalized.replaceAll(JSON.stringify(source.path), JSON.stringify("<SOURCE_PATH>"));
      }
      assert.equal(createHash("sha256").update(normalized).digest("hex"), expected[index]);
      assert.doesNotMatch(text, /characters omitted/);
      const ownerId = `legacy-${index}`, path = getRunDeliveryJournalPath(root, ownerId);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ schema: "run-delivery-v1", owner_id: ownerId, receipts: [], steers: [], completion_batch: legacy }));
      for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        phase({ batchId: legacy.batch_id, ownerId, tempDir: root });
        const saved = readRunDeliveryJournal(root, ownerId).completion_batch!;
        assert.equal(Object.hasOwn(saved, "excerpt_format"), false);
        assert.equal(formatRunCompletionBatchMessage(saved), text);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("New completion batches hand off one optional current-session request without changing legacy packet text or resolving paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-navigation-handoff-"));
  try {
    const fresh = admitRetainedFixture({ members: [member("first"), member("second")], ownerId: "fresh", tempDir: root });
    assert.equal(fresh.navigation_handoff, "current_session_request");
    const before = JSON.stringify(fresh), command = "inspect target=runtime view=runs verbose=true";
    const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const kill = process.kill, now = Date.now, forbidden = () => assert.fail("Rendering a navigation request resolved paths, sampled time or probed a process");
    Object.assign(fs, { readFileSync: forbidden, readdirSync: forbidden, statSync: forbidden, lstatSync: forbidden });
    process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
    let text: string;
    try { text = formatRunCompletionBatchMessage(fresh); }
    finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
    assert.equal(text.split(command).length - 1, 1); assert.match(text, /Files \(optional; current session\)/);
    assert.doesNotMatch(text, /\/tmp\/runs\/|context-index\.json|owner_session|session_id/);
    assert.equal(JSON.stringify(fresh), before); assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    for (const invalid of [true, false, "available", "", null, {}]) assert.throws(() => formatRunCompletionBatchMessage({ ...fresh,
      navigation_handoff: invalid } as unknown as typeof fresh), /navigation handoff/);
    markRunCompletionBatchQueued({ batchId: fresh.batch_id, ownerId: "fresh", tempDir: root });
    assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(root, "fresh").completion_batch!), text);
    const legacy = { batch_id: "legacy-navigation", created_at: "2026-08-31T12:00:00.000Z", members: [member("legacy")], phase: "pending" as const };
    const legacyText = formatRunCompletionBatchMessage(legacy); assert.equal(legacyText.includes(command), false);
    const path = getRunDeliveryJournalPath(root, "legacy"); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schema: "run-delivery-v1", owner_id: "legacy", receipts: [], steers: [], completion_batch: legacy }));
    for (const phase of ["pending", "queued", "presented"]) {
      if (phase === "queued") markRunCompletionBatchQueued({ batchId: legacy.batch_id, ownerId: "legacy", tempDir: root });
      if (phase === "presented") markRunCompletionBatchPresented({ batchId: legacy.batch_id, ownerId: "legacy", tempDir: root });
      const retained = readRunDeliveryJournal(root, "legacy").completion_batch!;
      assert.equal(Object.hasOwn(retained, "navigation_handoff"), false); assert.equal(formatRunCompletionBatchMessage(retained), legacyText);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("New captured-location packets freeze bounded identity-bound rows without retrofitting either older format", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-captured-navigation-"));
  try {
    const members = Array.from({ length: 40 }, (_, index) => ({ ...member(`work-${index}`), summary: "s".repeat(180), state_dir: join(root, "controlled", `work-${index}`) }));
    // Controlled data snapshots only; no original source/publication/native authority is asserted.
    const fileNavigation = capturedLocations(members.slice(0, 5));
    const saved = structuredClone(fileNavigation);
    const fresh = admitRetainedFixture({ members, fileNavigation, ownerId: "current", tempDir: root });
    assert.equal(fresh.navigation_handoff, "captured_file_locations"); assert.deepEqual(fresh.file_navigation, saved);
    fileNavigation[0].locations.files[0].path = "mutated";
    const originals = { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const kill = process.kill, now = Date.now, forbidden = () => assert.fail("Frozen reference rendering must not refresh IO/native/time");
    Object.assign(fs, { readFileSync: forbidden, readdirSync: forbidden, statSync: forbidden, lstatSync: forbidden }); process.kill = forbidden as typeof process.kill; Date.now = forbidden; syncBuiltinESMExports();
    let text: string;
    try { text = formatRunCompletionBatchMessage(fresh); }
    finally { Object.assign(fs, originals); process.kill = kill; Date.now = now; syncBuiltinESMExports(); }
    assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const counts = /Run files .*shown=(\d+) omitted=(\d+) total=(\d+)/.exec(text)!;
    const shown = Number(counts[1]); assert.ok(shown > 0 && shown < saved.length);
    assert.equal(shown + Number(counts[2]), members.length); assert.equal(Number(counts[3]), members.length);
    for (let index = 0; index < saved.length; index++) assert.equal(text.includes(JSON.stringify({ run: members[index].run, run_instance_id: members[index].run_instance_id, locations: fresh.file_navigation![index].locations })), index < shown);
    assert.ok(Object.isFrozen(fresh.file_navigation) && fresh.file_navigation!.every(row => Object.isFrozen(row) && Object.isFrozen(row.locations)));
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      transition({ batchId: fresh.batch_id, ownerId: "current", tempDir: root });
      assert.equal(formatRunCompletionBatchMessage(readRunDeliveryJournal(root, "current").completion_batch!), text);
    }
    for (const malformed of [{ ...fresh, navigation_handoff: "current_session_request" }, { ...fresh, file_navigation: undefined },
      { ...fresh, file_navigation: [{ member_index: 99, locations: saved[0].locations }] },
      { ...fresh, file_navigation: [{ member_index: 1, locations: saved[0].locations }] },
      { ...fresh, file_navigation: [saved[0], saved[0]] }]) assert.throws(() => formatRunCompletionBatchMessage(malformed as any), /navigation/);
    for (const navigation_handoff of [undefined, "current_session_request"] as const) {
      const old = { ...fresh, navigation_handoff, file_navigation: undefined, inventory_source: undefined };
      const legacy = formatRunCompletionBatchMessage(old);
      assert.doesNotMatch(legacy, /captured locations/); assert.ok(!legacy.includes(saved[0].locations.directory));
    }
    const parent = member("parent"), healthy = { ...member("healthy"), parent_run: parent.run, parent_run_instance_id: parent.run_instance_id, parent_state_dir: parent.state_dir };
    const failed = { ...healthy, ...member("failed"), status: "failed" as const };
    assert.deepEqual(orderRunCompletionMembers([healthy, failed, parent], true).map(member => member.run), ["parent", "failed", "healthy"]);
    assert.deepEqual(orderRunCompletionMembers([healthy, failed, parent]).map(member => member.run), ["parent", "healthy", "failed"]);
    const wrongParent = { ...healthy, parent_run: "not-the-recorded-parent" };
    assert.deepEqual(orderRunCompletionMembers([wrongParent, parent], true).map(member => member.run), ["healthy", "parent"], "Navigation must match the full parent tuple, not repair a wrong Run name from directory/generation");
    assert.deepEqual(orderRunCompletionMembers([wrongParent, parent]).map(member => member.run), ["parent", "healthy"], "Older outcome formatting stays unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Diagnostic packets freeze literal field/count/reference data and never reread sources across reload or phase changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-diagnostic-packet-"));
  try {
    const input = { ...member("diagnostic"), ...diagnosticBinding(member("diagnostic")) };
    input.state_dir = fixtureStateDir("diagnostic-`literal`"); input.result_diagnostics.source.path = join(input.state_dir, "evidence", `result-diagnostics-${"d".repeat(64)}.json`);
    const expected = structuredClone(input); const sourcePath = input.result_diagnostics.source.path;
    const open = fs.openSync; const read = fs.readFileSync;
    fs.openSync = ((path, ...args) => { assert.notEqual(String(path), sourcePath); return Reflect.apply(open, fs, [path, ...args]); }) as typeof fs.openSync;
    fs.readFileSync = ((path, ...args) => { assert.notEqual(String(path), sourcePath); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const batch = admitRetainedFixture({ members: [input], ownerId: "owner", tempDir: root }); const content = formatRunCompletionBatchMessage(batch);
      input.diagnostic_excerpt.text = "mutated"; input.result_diagnostics.source.sha256 = "b".repeat(64); input.result_diagnostics.fields[0] = "command";
      assert.deepEqual(batch.members[0], expected);
      for (const value of [batch.members[0]?.result_diagnostics, batch.members[0]?.result_diagnostics?.source, batch.members[0]?.result_diagnostics?.fields,
        batch.members[0]?.diagnostic_excerpt, batch.members[0]?.diagnostic_excerpt?.shown_bytes]) assert.equal(Object.isFrozen(value), true);
      assert.ok(content.includes(expected.diagnostic_excerpt.text)); assert.ok(content.includes(JSON.stringify(expected.result_diagnostics.source.path)));
      assert.ok(content.includes(expected.result_diagnostics.source.sha256));
      assert.match(content, /Diagnostic metadata only; not primary output; admission privacy for recorded fields\./);
      assert.doesNotMatch(content, /admission privacy applied\./);
      assert.match(content, /\[4 characters omitted\]; clipped/); assert.match(content, /Recorded fields not shown: failure_reason/);
      for (const phase of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        phase({ batchId: batch.batch_id, ownerId: "owner", tempDir: root });
        const stored = readRunDeliveryJournal(root, "owner").completion_batch!;
        assert.equal(formatRunCompletionBatchMessage(stored), content); assert.deepEqual(stored.members[0], expected);
      }
    } finally { fs.openSync = open; fs.readFileSync = read; syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Diagnostic packet data refuses legacy-body conflicts and detached/invalid excerpts while retaining quiet absence and explicit source loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-diagnostic-packet-data-"));
  try {
    const base = member("diagnostic"); const binding = diagnosticBinding(base);
    for (const value of [{ ...binding, output: "legacy diagnostic" }, { result_diagnostics: null, result_diagnostics_unavailable: "source_unavailable", output: "legacy diagnostic" },
      { diagnostic_excerpt: binding.diagnostic_excerpt }, { ...binding, diagnostic_excerpt: { ...binding.diagnostic_excerpt, chars_omitted: 99 } },
      { ...binding, diagnostic_excerpt: { ...binding.diagnostic_excerpt, field: "command" } },
      { ...diagnosticBinding(base, "x".repeat(1001)) }]) {
      assert.throws(() => admitRetainedFixture({ members: [{ ...base, ...value } as RunCompletionBatchMember], ownerId: "bad", tempDir: root }), /legacy display|source binding|excerpt is invalid/);
    }
    const lost = { ...base, result_diagnostics: null, result_diagnostics_unavailable: "source_unavailable" };
    const quiet = { ...member("quiet"), result_diagnostics: null, result_diagnostics_unavailable: "not_recorded" };
    const packet = admitRetainedFixture({ members: [lost, quiet], ownerId: "owner", tempDir: root });
    const content = formatRunCompletionBatchMessage(packet); assert.match(content, /Diagnostic metadata unavailable: source_unavailable; no legacy body fallback/);
    assert.doesNotMatch(content, /not_recorded/); assert.equal(content, formatRunCompletionBatchMessage(readRunDeliveryJournal(root, "owner").completion_batch!));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Captured-member overflow retains diagnostic references/unavailability but never diagnostic excerpts or legacy bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-diagnostic-packet-overflow-"));
  try {
    const members = Array.from({ length: 80 }, (_, index) => ({ ...member(`diagnostic-${index}`), ...diagnosticBinding(member(`diagnostic-${index}`), "METADATA_PREVIEW_CANARY" + "界".repeat(900)) }));
    const batch = admitRetainedFixture({ members, ownerId: "owner", tempDir: root }); assert.ok(batch.inventory_source);
    const source = batch.inventory_source!; const content = fs.readFileSync(source.path); const inventory = JSON.parse(content.toString());
    assert.equal(createHash("sha256").update(content).digest("hex"), source.sha256); assert.equal(source.bytes_total, content.length);
    assert.equal(inventory.result_diagnostics, "captured_bindings_only"); assert.equal(inventory.members.length, 80);
    assert.equal(inventory.diagnostics, "not_included"); assert.doesNotMatch(content.toString(), /METADATA_PREVIEW_CANARY|diagnostic_excerpt|state_dir/);
    assert.deepEqual(inventory.members.map((value: any) => value.result_diagnostics), members.map(value => value.result_diagnostics));
    assert.ok(formatRunCompletionBatchMessage(batch).includes(JSON.stringify(source.path)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function primaryBinding(item: RunCompletionBatchMember, preview: string, suffix = "TAIL") {
  const full = preview + suffix;
  return { output: {
    source: { path: join(item.state_dir, "evidence", `primary-${"a".repeat(64)}.txt`),
      run_instance_id: item.run_instance_id, sha256: createHash("sha256").update(full).digest("hex") },
    bytes_total: Buffer.byteLength(full), shown_bytes: { start: 0, end: Buffer.byteLength(preview) },
    chars_total: [...full].length, chars_shown: [...preview].length, chars_omitted: [...suffix].length,
    preview, truncated: suffix.length > 0, redacted: true,
  } };
}

test("Primary completion packets freeze curated descriptors across mutation, reload and delivery phases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-primary-packet-"));
  try {
    const input = { ...member("primary"), primary_text: primaryBinding(member("primary"), " \r\n\uFEFF🌍\uFFFD\t\n```` tricky  \r\n") };
    const expected = JSON.parse(JSON.stringify(input));
    const batch = admitRetainedFixture({ members: [input], ownerId: "owner", tempDir: root, batchId: "primary-batch" });
    const content = formatRunCompletionBatchMessage(batch);
    input.primary_text.output.preview = "mutated"; input.primary_text.output.source.sha256 = "b".repeat(64); input.summary = "mutated";
    assert.equal(Object.isFrozen(batch.members), true); assert.equal(Object.isFrozen(batch.members[0]), true);
    assert.equal(Object.isFrozen(batch.members[0].artifacts), true);
    assert.equal(Object.isFrozen(batch.members[0].primary_text?.output?.source), true);
    assert.equal(Object.isFrozen(batch.members[0].primary_text?.output?.shown_bytes), true);
    assert.deepEqual(batch.members[0], expected);
    assert.ok(content.includes(expected.primary_text.output.preview), "Tracked preview is byte-exact, including CRLF, whitespace, backticks and BOM");
    assert.ok(content.includes(JSON.stringify(expected.primary_text.output.source.path))); assert.ok(content.includes(expected.primary_text.output.source.sha256));
    assert.match(content, /code points; \[4 characters omitted\]; clipped; redacted/);
    for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
      assert.equal(transition({ ownerId: "owner", tempDir: root, batchId: batch.batch_id }), true);
      const recovered = readRunDeliveryJournal(root, "owner").completion_batch!;
      assert.deepEqual(recovered.members[0], expected); assert.equal(formatRunCompletionBatchMessage(recovered), content);
    }
  } finally { await rm(root, { recursive:true, force:true }); }
});

test("Primary packet parsing refuses mismatched bindings and never interprets legacy display as the tracked source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-primary-parse-"));
  try {
    const original = member("a"); const binding = primaryBinding(original, "🌍");
    const candidates = [
      { ...binding, output: { ...binding.output, chars_shown: 2 } },
      { ...binding, output: { ...binding.output, source: { ...binding.output.source, run_instance_id: "foreign" } } },
      { ...binding, output: { ...binding.output, source: { ...binding.output.source, path: "/private/stdout.log" } } },
      { output: null, output_unavailable: "bad\nreason" },
    ];
    for (const primary_text of candidates) assert.throws(() => admitRetainedFixture({
      members: [{ ...original, primary_text } as RunCompletionBatchMember], ownerId: "owner", tempDir: root,
    }), /primary text binding/);
    assert.throws(() => admitRetainedFixture({ members: [{ ...original, primary_text: binding, output: "ambiguous body" }],
      ownerId: "owner", tempDir: root }), /cannot also carry a legacy display/);
    const batch = admitRetainedFixture({ members: [{ ...original, primary_text: { output: null, output_unavailable: "not_selected" }, output: "legacy body" }],
      ownerId: "owner", tempDir: root });
    const text = formatRunCompletionBatchMessage(batch);
    assert.match(text, /Primary output unavailable: not_selected/); assert.match(text, /Legacy diagnostic display \(not a complete primary source\)/);
  } finally { await rm(root, { recursive:true, force:true }); }
});

test("Primary completion forests preserve whole excerpts and full source references within the existing shared model budget", () => {
  const members = Array.from({ length: 80 }, (_, i) => {
    const item = member(`run-${i}`); return { ...item, primary_text: primaryBinding(item, "START\n" + "`".repeat(800) + "\n🌍 END") };
  });
  const batch = { batch_id: "forest", created_at: "2026-08-31T12:00:00.000Z", members, phase: "pending" as const };
  const text = formatRunCompletionBatchMessage(batch);
  assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES); assert.match(text, /more completion\(s\) retained in batch/);
  for (const item of members) {
    const source = item.primary_text.output;
    if (text.includes(JSON.stringify(source.source.path))) assert.ok(text.includes(source.preview));
  }
});

test("Overflow projection links a complete captured member inventory without disclosing owner journal, private locations or diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-"));
  try {
    admitRunSteerEnvelope({ ownerId: "owner-secret", tempDir: root, content: "private-steer-canary", eventId: "event", kind: "note", level: "info", occurredAt: "2026-08-31T12:00:00Z", run: "urgent", runInstanceId: "urgent-g", stateDir: "/private-steer-location" });
    const members = Array.from({ length: 80 }, (_, i) => {
      const item = { ...member(`inventory-${i}`), summary: "summary-canary", artifacts: { report: "/artifact-canary" } };
      return i % 2 ? { ...item, state_dir: "/private-location-canary/" + i, output: "diagnostic-canary",
        parent_run: "inventory-0", parent_run_instance_id: "generation-inventory-0", parent_state_dir: fixtureStateDir("inventory-0") }
        : { ...item, primary_text: primaryBinding(item, "\uFEFF🌍 ````\r\n" + "x".repeat(2400)) };
    });
    const batch = admitRetainedFixture({ members, ownerId: "owner-secret", tempDir: root });
    const text = formatRunCompletionBatchMessage(batch); assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
    const references = [...text.matchAll(/(`{3,})text\n([\s\S]*?)\n\1/gu)].flatMap(match => { try { return [JSON.parse(match[2])]; } catch { return []; } });
    const reference = references.find(value => value.members_total === 80); assert.deepEqual(reference, batch.inventory_source); assert.ok(reference);
    const bytes = fs.readFileSync(reference.path); assert.equal(bytes.length, reference.bytes_total);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.sha256);
    const inventory = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.equal(inventory.scope, "captured_completion_members"); assert.equal(inventory.members_total, 80);
    assert.deepEqual(inventory.members.map((item: { run: string; run_instance_id: string }) => [item.run, item.run_instance_id]), members.map(item => [item.run, item.run_instance_id]));
    assert.equal(inventory.members[1].parent_run, "inventory-0"); assert.equal(inventory.members[1].parent_run_instance_id, "generation-inventory-0");
    assert.equal(inventory.artifacts, "not_included"); assert.equal(inventory.diagnostics, "not_included"); assert.equal(inventory.private_locations, "not_included");
    assert.doesNotMatch(bytes.toString("utf8"), /owner-secret|private-steer|private-location-canary|summary-canary|artifact-canary|diagnostic-canary|state_dir/);
    for (let i = 0; i < members.length; i += 2) assert.deepEqual(inventory.members[i].primary_text, batch.members[i]!.primary_text);
    const shown = text.split("\n").filter(line => /^\s*- `inventory-/.test(line)).length;
    assert.ok(shown < 80); assert.ok(text.includes(`${80 - shown} more completion(s)`));
    const small = admitRetainedFixture({ members: [member("small")], ownerId: "other", tempDir: root }); assert.equal(small.inventory_source, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Captured overflow inventory bindings survive phases and source loss without rereading, repair or implicit ACK", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-phases-"));
  try {
    const members = Array.from({ length: 80 }, (_, i) => member(`phase-${i}`));
    const batch = admitRetainedFixture({ members, ownerId: "owner", tempDir: root }); const source = batch.inventory_source!;
    const bytes = fs.readFileSync(source.path); const text = formatRunCompletionBatchMessage(batch); assert.equal(Object.isFrozen(source), true);
    members[79]!.run = "mutated";
    assert.equal(markRunCompletionBatchQueued({ batchId: batch.batch_id, ownerId: "owner", tempDir: root }), true);
    assert.deepEqual(fs.readFileSync(source.path), bytes);
    fs.unlinkSync(source.path);
    const read = fs.readFileSync; fs.readFileSync = ((path, ...args) => { assert.notEqual(String(path), source.path); return read(path, ...args); }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const recovered = readRunDeliveryJournal(root, "owner").completion_batch!;
      assert.equal(recovered.phase, "queued"); assert.deepEqual(recovered.inventory_source, source); assert.equal(formatRunCompletionBatchMessage(recovered), text);
      assert.equal(markRunCompletionBatchPresented({ batchId: batch.batch_id, ownerId: "owner", tempDir: root }), true);
      assert.equal(finalizeRunCompletionBatch({ batchId: batch.batch_id, ownerId: "owner", tempDir: root }), true);
    } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
    assert.equal(fs.existsSync(source.path), false);
    const legacy = formatRunCompletionBatchMessage({ ...batch, inventory_source: undefined }); assert.match(legacy, /No inventory reference is retained in this packet/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Overflow retention and journal failure preserve exact errors and unpublished source effects without overwrite or retry", async () => {
  for (const failingEffect of ["source", "journal"]) {
    const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-fault-"));
    const write = fs.writeFileSync; const rename = fs.renameSync; const primary = Object.assign(new Error(`injected ${failingEffect} failure`), { code: "EIO" }); let sourcePath = "";
    const input = { members: Array.from({ length: 80 }, (_, i) => member(`fault-${i}`)), ownerId: "owner", tempDir: root, batchId: "same-batch", now: new Date("2026-08-31T12:00:00Z") };
    try {
      fs.writeFileSync = ((path, data, ...args) => {
        if (typeof path === "string" && basename(path).startsWith("inventory-") && path.endsWith(".json")) {
          sourcePath = path;
          if (failingEffect === "source") { write(path, "partial", { flag: "wx" }); throw primary; }
        }
        return write(path, data, ...args);
      }) as typeof fs.writeFileSync;
      fs.renameSync = ((from, to) => { if (failingEffect === "journal" && String(to).endsWith("projection.json")) throw primary; return rename(from, to); }) as typeof fs.renameSync;
      syncBuiltinESMExports();
      assert.throws(() => admitRetainedFixture(input), error => error === primary);
    } finally { fs.writeFileSync = write; fs.renameSync = rename; syncBuiltinESMExports(); }
    try {
      assert.ok(sourcePath); assert.equal(readRunDeliveryJournal(root, "owner").completion_batch, undefined);
      const retained = fs.readFileSync(sourcePath); assert.equal(failingEffect === "source" ? retained.toString() === "partial" : JSON.parse(retained.toString()).members_total === 80, true);
      assert.throws(() => admitRetainedFixture(input), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
      assert.deepEqual(fs.readFileSync(sourcePath), retained); assert.equal(readRunDeliveryJournal(root, "owner").completion_batch, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("Candidate effect preflight rejects journal overflow before inventory creation attempts", async () => {
  const { describeRunArtifactReferences } = await import("../lib/runs-artifacts.ts");
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-effect-cap-"));
  const descriptor = Object.getOwnPropertyDescriptor(fs, "writeFileSync")!;
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  let writes = 0, opens = 0;
  try {
    const members = Array.from({ length: 65 }, (_, i) => ({ ...member(`capacity-${i}`),
      artifacts: Object.fromEntries(["a", "b", "c", "d"].map(key => [key, "/" + "p".repeat(4095)])) }));
    for (const item of members) assert.equal(describeRunArtifactReferences(item.artifacts, item.state_dir).state, "available");
    const journalPath = getRunDeliveryJournalPath(root, "owner");
    const isInventory = (path: unknown) => typeof path === "string" && dirname(path) === dirname(journalPath) && /^inventory-.*\.json$/.test(basename(path));
    fs.writeFileSync = ((path, ...args) => { if (isInventory(path)) writes++; return Reflect.apply(descriptor.value, fs, [path, ...args]); }) as typeof fs.writeFileSync;
    fs.openSync = ((path, ...args) => { if (isInventory(path)) opens++; return Reflect.apply(openDescriptor.value, fs, [path, ...args]); }) as typeof fs.openSync;
    syncBuiltinESMExports();
    assert.throws(() => deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch({ members, ownerId: "owner", tempDir: root }), /Run delivery journal exceeds the byte limit/);
    assert.equal(writes, 0); assert.equal(opens, 0); assert.equal(fs.existsSync(journalPath), false);
    assert.equal(readRunDeliveryJournal(root, "owner").completion_batch, undefined);
    console.log("candidate-effect-preflight", JSON.stringify({ members: members.length, declarationBytes: 65 * 4 * 4096, writes, opens, journalAbsent: true }));
  } finally {
    Object.defineProperty(fs, "writeFileSync", descriptor); Object.defineProperty(fs, "openSync", openDescriptor); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const effect of ["orphan", "commit"] as const) test(`Candidate effect ${effect} preserves exclusive inventory and prior journal uncertainty`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-candidate-effect-"));
  const descriptor = Object.getOwnPropertyDescriptor(fs, "renameSync")!;
  const input = { members: Array.from({ length: 65 }, (_, i) => {
    const { artifacts, ...base } = member(`effect-${i}`); return base;
  }), ownerId: "owner", tempDir: root, batchId: "effect", now: new Date("2026-08-31T12:00:00Z") };
  const journalPath = getRunDeliveryJournalPath(root, input.ownerId);
  const inventory = `${JSON.stringify({ schema: "run-completion-inventory-v1", batch_id: input.batchId, created_at: input.now.toISOString(),
    scope: "captured_completion_members", members_total: 65, artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
    members: input.members.map(m => ({ run: m.run, run_instance_id: m.run_instance_id, status: m.status, terminal_at: m.terminal_at })) }, null, 2)}\n`;
  const sourcePath = join(dirname(journalPath), `inventory-${createHash("sha256").update(inventory).digest("hex")}.json`);
  const primary = Object.assign(new Error("candidate controlled journal commit fault"), { code: "EIO" });
  let reached = 0;
  try {
    if (effect === "orphan") { await mkdir(dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, inventory, { flag: "wx" }); }
    fs.renameSync = ((from, to) => {
      if (String(to) === journalPath) {
        reached++; assert.equal(fs.readFileSync(sourcePath, "utf8"), inventory);
        throw primary;
      }
      return Reflect.apply(descriptor.value, fs, [from, to]);
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
    assert.throws(() => deliveryYamlPrototype.captureRunCompletionYamlCandidateBatch(input), error => effect === "commit" ? error === primary : (error as NodeJS.ErrnoException).code === "EEXIST");
    assert.equal(reached, effect === "commit" ? 1 : 0);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), inventory);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(readRunDeliveryJournal(root, input.ownerId).completion_batch, undefined);
    console.log("candidate-effect", JSON.stringify({ effect, reached, members: 65, sourceBytes: Buffer.byteLength(inventory), journalAbsent: true, error: effect === "commit" ? "exact EIO sentinel" : "EEXIST" }));
  } finally {
    Object.defineProperty(fs, "renameSync", descriptor); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("Known journal overflow refuses inventory publication before any source file effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-capacity-"));
  try {
    const members = Array.from({ length: 256 }, (_, i) => ({ ...member(`capacity-${i}`), summary: "s".repeat(1000), output: "d".repeat(4000) }));
    assert.throws(() => admitRetainedFixture({ members, ownerId: "owner", tempDir: root }), /journal exceeds the byte limit/);
    const path = getRunDeliveryJournalPath(root, "owner");
    assert.equal(fs.existsSync(dirname(path)), false); assert.equal(readRunDeliveryJournal(root, "owner").completion_batch, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Overflow inventory schema binds exact membership and owner location without opening the retained source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-inventory-schema-"));
  try {
    const batch = admitRetainedFixture({ members: Array.from({ length: 80 }, (_, i) => member(`schema-${i}`)), ownerId: "owner", tempDir: root });
    for (const changed of [{ sha256: "b".repeat(64) }, { bytes_total: 1 }, { members_total: 79 }]) {
      assert.throws(() => formatRunCompletionBatchMessage({ ...batch, inventory_source: { ...batch.inventory_source!, ...changed } }), /source binding/);
    }
    assert.throws(() => formatRunCompletionBatchMessage({ ...batch, members: batch.members.slice(1) }), /source binding/);
    const path = getRunDeliveryJournalPath(root, "owner"); const journal = JSON.parse(fs.readFileSync(path, "utf8"));
    journal.completion_batch.inventory_source.path = join(root, "foreign", basename(batch.inventory_source!.path));
    fs.writeFileSync(path, JSON.stringify(journal)); assert.throws(() => readRunDeliveryJournal(root, "owner"), /another delivery location/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Artifact completion bindings freeze literal inventory references and unavailability through packet reload/phases without source reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-packet-"));
  try {
    const { artifacts: _legacy, ...facts } = member("artifact-packet"); const base = { ...facts, state_dir: join(root, "state````🌍") };
    const inventory = { source: { path: join(base.state_dir, "evidence", `artifact-inventory-${"a".repeat(64)}.json`), run_instance_id: base.run_instance_id, sha256: "b".repeat(64) }, bytes_total: 2000, declarations_total: 5 };
    const expected = JSON.parse(JSON.stringify(inventory)); const input = { ...base, artifact_inventory: inventory };
    const batch = admitRetainedFixture({ members: [input], ownerId: "owner", tempDir: root });
    const text = formatRunCompletionBatchMessage(batch); inventory.source.sha256 = "c".repeat(64); inventory.declarations_total = 99;
    assert.deepEqual(batch.members[0]!.artifact_inventory, expected); assert.equal(Object.isFrozen(batch.members[0]!.artifact_inventory?.source), true);
    assert.ok(text.includes(JSON.stringify(expected.source.path))); assert.ok(text.includes(expected.source.sha256)); assert.match(text, /Artifact declarations: 5; metadata only/);
    assert.match(text, /target availability\/production not asserted; bodies not read/); assert.match(text, /Retained declaration inventory at capture/);
    const read = fs.readFileSync; fs.readFileSync = ((path, ...args) => { assert.notEqual(String(path), expected.source.path); return Reflect.apply(read, fs, [path, ...args]); }) as typeof fs.readFileSync; syncBuiltinESMExports();
    try {
      for (const transition of [markRunCompletionBatchQueued, markRunCompletionBatchPresented]) {
        transition({ batchId: batch.batch_id, ownerId: "owner", tempDir: root });
        const recovered = readRunDeliveryJournal(root, "owner").completion_batch!;
        assert.deepEqual(recovered.members[0]!.artifact_inventory, expected); assert.equal(formatRunCompletionBatchMessage(recovered), text);
      }
    } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
    for (const binding of [{ artifact_inventory: expected }, { artifact_inventory: null, artifact_inventory_unavailable: "source_unavailable" }]) {
      assert.throws(() => admitRetainedFixture({ members: [{ ...base, artifacts: { report: "/raw-legacy-path" }, ...binding }], ownerId: "other", tempDir: root }), /cannot also carry legacy artifact paths/);
    }
    const missing = admitRetainedFixture({ members: [{ ...base, artifact_inventory: null, artifact_inventory_unavailable: "source_unavailable" }], ownerId: "missing", tempDir: root });
    assert.match(formatRunCompletionBatchMessage(missing), /Artifact inventory unavailable: source_unavailable; no legacy path fallback/);
    const quiet = admitRetainedFixture({ members: [{ ...base, artifact_inventory: null, artifact_inventory_unavailable: "not_declared" }], ownerId: "quiet", tempDir: root });
    assert.doesNotMatch(formatRunCompletionBatchMessage(quiet), /Artifact inventory|Artifact declarations/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Overflow captured-member inventories retain artifact bindings, not raw declaration paths or bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-forest-"));
  try {
    const members = Array.from({ length: 80 }, (_, i) => { const { artifacts: _legacy, ...base } = member(`artifact-${i}`);
      return { ...base, artifact_inventory: { source: { path: join(base.state_dir, "evidence", `artifact-inventory-${"a".repeat(64)}.json`), run_instance_id: base.run_instance_id, sha256: "b".repeat(64) }, bytes_total: 2000, declarations_total: 5 } }; });
    const batch = admitRetainedFixture({ members, ownerId: "owner", tempDir: root }); const text = formatRunCompletionBatchMessage(batch);
    assert.ok(Buffer.byteLength(text) <= Limits.RUN_DELIVERY_MODEL_MAX_BYTES); assert.ok(batch.inventory_source);
    const inventory = JSON.parse(fs.readFileSync(batch.inventory_source.path, "utf8")); assert.equal(inventory.artifact_inventory, "captured_bindings_only");
    assert.equal(inventory.members.length, 80); assert.deepEqual(inventory.members[79].artifact_inventory, members[79]!.artifact_inventory);
    assert.equal(inventory.artifacts, "not_included"); assert.equal(inventory.diagnostics, "not_included");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Run delivery paths hide exact owner identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const owner = "session/owner:private";
    const first = getRunDeliveryJournalPath(root, owner);
    assert.equal(first, getRunDeliveryJournalPath(root, owner));
    assert.equal(first.includes(owner), false);
    assert.match(first, /delivery[/\\][0-9a-f]{64}[/\\]projection\.json$/);
    assert.notEqual(first, getRunDeliveryJournalPath(root, `${owner}-other`));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery admits one exact owner-fenced completion batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const batch = admitRunCompletionBatch({
      batchId: "batch-a",
      members: [member("a"), { ...member("b"), status: "failed" }],
      now: new Date("2026-08-31T12:01:00.000Z"),
      ownerId: "session-a",
      tempDir: root,
    });
    assert.equal(batch.phase, "pending");
    assert.deepEqual(batch.members.map((item) => [item.run, item.status]), [
      ["a", "done"],
      ["b", "failed"],
    ]);
    assert.deepEqual(readRunDeliveryJournal(root, "session-a"), {
      completion_batch: batch,
      owner_id: "session-a",
      receipts: [],
      schema: "run-delivery-v1",
      steers: [],
    });
    assert.throws(
      () => admitRunCompletionBatch({
        batchId: "batch-b",
        members: [member("c")],
        ownerId: "session-a",
        tempDir: root,
      }),
      /already has an active completion batch/,
    );
    await writeFile(
      getRunDeliveryJournalPath(root, "session-a"),
      `${JSON.stringify({
        ...readRunDeliveryJournal(root, "session-a"),
        owner_id: "session-b",
      })}\n`,
      "utf8",
    );
    assert.throws(
      () => readRunDeliveryJournal(root, "session-a"),
      /owner does not match/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery phases are monotonic fenced and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    admitRunCompletionBatch({
      batchId: "batch-a",
      members: [member("a")],
      ownerId: "session-a",
      tempDir: root,
    });
    assert.equal(markRunCompletionBatchPresented({
      batchId: "batch-a",
      ownerId: "session-a",
      tempDir: root,
    }), false);
    assert.equal(markRunCompletionBatchQueued({
      batchId: "missing",
      ownerId: "session-a",
      tempDir: root,
    }), false);
    assert.equal(markRunCompletionBatchQueued({
      batchId: "batch-a",
      now: new Date("2026-08-31T12:02:00.000Z"),
      ownerId: "session-a",
      tempDir: root,
    }), true);
    assert.equal(markRunCompletionBatchQueued({
      batchId: "batch-a",
      now: new Date("2026-08-31T12:03:00.000Z"),
      ownerId: "session-a",
      tempDir: root,
    }), true);
    assert.equal(
      readRunDeliveryJournal(root, "session-a").completion_batch?.queued_at,
      "2026-08-31T12:02:00.000Z",
    );
    assert.equal(markRunCompletionBatchPresented({
      batchId: "batch-a",
      now: new Date("2026-08-31T12:04:00.000Z"),
      ownerId: "session-a",
      tempDir: root,
    }), true);
    assert.equal(finalizeRunCompletionBatch({
      batchId: "batch-a",
      ownerId: "session-a",
      tempDir: root,
    }), true);
    assert.equal(finalizeRunCompletionBatch({
      batchId: "batch-a",
      ownerId: "session-a",
      tempDir: root,
    }), true);
    assert.deepEqual(readRunDeliveryJournal(root, "session-a"), {
      owner_id: "session-a",
      receipts: [{
        delivery_id: "batch-a",
        kind: "completion_batch",
        presented_at: "2026-08-31T12:04:00.000Z",
      }],
      schema: "run-delivery-v1",
      steers: [],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery preserves bounded send failure and queued recovery evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    admitRunCompletionBatch({
      batchId: "batch-recovery",
      members: [member("a")],
      ownerId: "session-a",
      tempDir: root,
    });
    assert.equal(recordRunCompletionBatchDeliveryFailure({
      batchId: "batch-recovery",
      error: new Error(`send failed ${"detail ".repeat(1_000)}`),
      now: new Date("2026-08-31T12:01:00.000Z"),
      ownerId: "session-a",
      tempDir: root,
    }), true);
    let batch = readRunDeliveryJournal(root, "session-a").completion_batch;
    assert.equal(batch?.attempts, 1);
    assert.equal((batch?.last_error?.length ?? 0) <= 4_096, true);
    assert.equal(batch?.last_failed_at, "2026-08-31T12:01:00.000Z");
    markRunCompletionBatchQueued({
      batchId: "batch-recovery",
      ownerId: "session-a",
      tempDir: root,
    });
    assert.equal(resetRunCompletionBatchPending({
      batchId: "batch-recovery",
      ownerId: "session-a",
      tempDir: root,
    }), true);
    batch = readRunDeliveryJournal(root, "session-a").completion_batch;
    assert.equal(batch?.phase, "pending");
    assert.equal(batch?.queued_at, undefined);
    assert.equal(batch?.attempts, 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery formats bounded model-facing completion rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const members = Array.from(
      { length: Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS },
      (_, index) => ({
        ...member(`run-${String(index).padStart(3, "0")}`),
        ...(index === 0 ? { output: "Reviewer answer: approved." } : {}),
        status: index % 2 === 0 ? "done" as const : "failed" as const,
        summary: `Completed row ${index} ${"detail ".repeat(100)}`,
      }),
    );
    const batch = admitRunCompletionBatch({
      batchId: "batch-model",
      members,
      ownerId: "session-a",
      tempDir: root,
    });
    const message = formatRunCompletionBatchMessage(batch);
    const rows = coreRows(message), header = rows[0].metadata;
    assert.deepEqual([header.index, header.run, header.state], [0, "run-000", "done"]);
    assert.equal(header._completion.batch_id, "batch-model");
    assert.doesNotMatch(message, /^- (?:completions|members|done_count|failed_count|window_start|window_end):/mu);
    const shown = rows.filter(row => row.metadata.run !== undefined).length;
    assert.equal(header._completion.service.omitted_results, members.length - shown);
    assert.equal(header._completion.service.omitted_states.failed, members.slice(shown).filter(member => member.status === "failed").length);
    assert.match(message, /\nReviewer answer: approved\./u);
    assert.equal(
      message.split("\n").filter((line) => line.startsWith("run:")).length <=
        Limits.RUN_DELIVERY_MODEL_MAX_MEMBERS,
      true,
    );
    assert.equal(
      Buffer.byteLength(message, "utf8") <= Limits.RUN_COMPLETION_MODEL_MAX_BYTES,
      true,
    );
    assert.equal(
      readRunDeliveryJournal(root, "session-a").completion_batch?.members.length,
      Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery formats each completion tree in stable preorder", () => {
  const rootA = member("root-a");
  const rootB = member("root-b");
  const childA = {
    ...member("child-a"),
    parent_run: rootA.run,
    parent_run_instance_id: rootA.run_instance_id,
    parent_state_dir: rootA.state_dir,
  };
  const message = formatRunCompletionBatchMessage({
    batch_id: "batch-forest",
    created_at: "2026-08-31T12:00:00.000Z",
    members: [rootA, rootB, childA],
    phase: "pending",
  });
  assert.ok(message.indexOf("`root-a`") < message.indexOf("`child-a`"));
  assert.ok(message.indexOf("`child-a`") < message.indexOf("`root-b`"));
  assert.match(message, /\n  - `child-a`/);
});

test("Run delivery rejects invalid duplicate and excessive members", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    assert.throws(
      () => admitRunCompletionBatch({
        members: [],
        ownerId: "session-a",
        tempDir: root,
      }),
      /non-empty array/,
    );
    assert.throws(
      () => admitRunCompletionBatch({
        members: [member("a"), member("other", "generation-a")].map((item) => ({
          ...item,
          state_dir: fixtureStateDir("a"),
        })),
        ownerId: "session-a",
        tempDir: root,
      }),
      /duplicate generation/,
    );
    assert.throws(
      () => admitRunCompletionBatch({
        members: [{ ...member("a"), status: "cancelled" as "done" }],
        ownerId: "session-a",
        tempDir: root,
      }),
      /status is invalid/,
    );
    assert.throws(
      () => admitRunCompletionBatch({
        members: Array.from(
          { length: Limits.RUN_DELIVERY_BATCH_MAX_MEMBERS + 1 },
          (_, index) => member(`run-${index}`),
        ),
        ownerId: "session-a",
        tempDir: root,
      }),
      /member limit/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery fails closed on malformed oversized and symlinked state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const path = getRunDeliveryJournalPath(root, "session-a");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken", "utf8");
    assert.throws(() => readRunDeliveryJournal(root, "session-a"), /malformed/);
    await writeFile(path, JSON.stringify({
      owner_id: "session-a",
      receipts: [],
      schema: "run-delivery-v1",
      steers: null,
    }), "utf8");
    assert.throws(
      () => readRunDeliveryJournal(root, "session-a"),
      /urgent steers are invalid/,
    );
    await writeFile(path, "x".repeat(Limits.RUN_DELIVERY_JOURNAL_MAX_BYTES + 1), "utf8");
    assert.throws(() => readRunDeliveryJournal(root, "session-a"), /bounded regular file/);
    if (process.platform === "win32") {
      t.diagnostic("symbolic-link fixture requires elevated Windows privileges");
      return;
    }
    await rm(path, { force: true });
    const target = join(root, "foreign.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, path);
    assert.throws(() => readRunDeliveryJournal(root, "session-a"), /symbolic link/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery durably fences urgent steer phases and receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const identity = {
      eventId: "event-a",
      runInstanceId: "generation-a",
      stateDir: "/tmp/runs/a",
    };
    const steerId = getRunSteerDeliveryId(identity);
    const admitted = admitRunSteerEnvelope({
      content: "Run a requires approval.",
      ...identity,
      kind: "checkpoint.blocked",
      level: "warning",
      now: new Date("2026-08-31T12:00:00.000Z"),
      occurredAt: "2026-08-31T11:59:00.000Z",
      ownerId: "session-a",
      run: "a",
      tempDir: root,
    });
    assert.equal(admitted?.steer_id, steerId);
    assert.equal(admitRunSteerEnvelope({
      content: "Run a requires approval.",
      ...identity,
      kind: "checkpoint.blocked",
      level: "warning",
      occurredAt: "2026-08-31T11:59:00.000Z",
      ownerId: "session-a",
      run: "a",
      tempDir: root,
    })?.steer_id, steerId);
    assert.equal(recordRunSteerDeliveryFailure({
      error: new Error("send failed"),
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    assert.equal(markRunSteerQueued({
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    assert.equal(resetRunSteerPending({
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    assert.equal(markRunSteerQueued({
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    assert.equal(markRunSteerPresented({
      now: new Date("2026-08-31T12:02:00.000Z"),
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    assert.equal(finalizeRunSteer({
      ownerId: "session-a",
      steerId,
      tempDir: root,
    }), true);
    const journal = readRunDeliveryJournal(root, "session-a");
    assert.deepEqual(journal.steers, []);
    assert.deepEqual(journal.receipts, [{
      delivery_id: steerId,
      kind: "urgent_steer",
      presented_at: "2026-08-31T12:02:00.000Z",
    }]);
    assert.equal(admitRunSteerEnvelope({
      content: "Run a requires approval.",
      ...identity,
      kind: "checkpoint.blocked",
      level: "warning",
      occurredAt: "2026-08-31T11:59:00.000Z",
      ownerId: "session-a",
      run: "a",
      tempDir: root,
    }), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery keeps urgent steer capacity explicit and retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    for (let index = 0; index < Limits.RUN_DELIVERY_STEER_MAX_ENVELOPES; index += 1) {
      admitRunSteerEnvelope({
        content: `Steer ${index}`,
        eventId: `event-${index}`,
        kind: "checkpoint.blocked",
        level: "warning",
        occurredAt: "2026-08-31T11:59:00.000Z",
        ownerId: "session-a",
        run: `run-${index}`,
        runInstanceId: `generation-${index}`,
        stateDir: fixtureStateDir(String(index)),
        tempDir: root,
      });
    }
    assert.throws(() => admitRunSteerEnvelope({
      content: "Overflow",
      eventId: "event-overflow",
      kind: "checkpoint.blocked",
      level: "warning",
      occurredAt: "2026-08-31T11:59:00.000Z",
      ownerId: "session-a",
      run: "overflow",
      runInstanceId: "generation-overflow",
      stateDir: fixtureStateDir("overflow"),
      tempDir: root,
    }), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "RUN_STEER_CAPACITY");
    assert.equal(
      readRunDeliveryJournal(root, "session-a").steers.length,
      Limits.RUN_DELIVERY_STEER_MAX_ENVELOPES,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Run delivery receipts retain one bounded newest tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-delivery-"));
  try {
    const count = Limits.RUN_DELIVERY_RECEIPT_LIMIT + 2;
    for (let index = 0; index < count; index += 1) {
      const batchId = `batch-${index}`;
      admitRunCompletionBatch({
        batchId,
        members: [member(`run-${index}`)],
        ownerId: "session-a",
        tempDir: root,
      });
      markRunCompletionBatchQueued({
        batchId,
        ownerId: "session-a",
        tempDir: root,
      });
      markRunCompletionBatchPresented({
        batchId,
        ownerId: "session-a",
        tempDir: root,
      });
      finalizeRunCompletionBatch({
        batchId,
        ownerId: "session-a",
        tempDir: root,
      });
    }
    const receipts = readRunDeliveryJournal(root, "session-a").receipts;
    assert.equal(receipts.length, Limits.RUN_DELIVERY_RECEIPT_LIMIT);
    assert.equal(receipts[0].delivery_id, "batch-2");
    assert.equal(receipts.at(-1)?.delivery_id, `batch-${count - 1}`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unadmitted YAML core preserves opaque selected parts and derives dense slices", () => {
  const api = deliveryYamlPrototype as unknown as Record<string, Function>;
  assert.equal(typeof api.encodeCompletionYamlCarrier, "function", "pure YAML encoder is missing");
  assert.equal(typeof api.readCompletionYamlCarrier, "function", "pure YAML decoder is missing");
  const input = { batchId: "packet-one", records: [{ metadata: { index: "?", run: "demo", state: "done", kind: "primary" },
    parts: [{ body: "\uFEFF---\r\nindex: forged\n<!-- runtime -->\n```\n😀\r" }, { marker: "[3 characters omitted]" }, { body: "\nnext:\n- tool: inspect" }] }] };
  const encoded = api.encodeCompletionYamlCarrier!(input);
  assert.equal(encoded.state, "available");
  const decoded = api.readCompletionYamlCarrier!(encoded.text);
  assert.equal(decoded.state, "available");
  assert.deepEqual(decoded.packet, input);
  for (const block of decoded.blocks) {
    if (block.kind === "body" || block.kind === "marker") {
      assert.equal(encoded.text.slice(block.start, block.end), Object.values(input.records[0]!.parts[block.part]!)[0]);
    }
  }
});

function yamlCoreRow(index = 0, parts: CompletionYamlPacket["records"][number]["parts"] = []): CompletionYamlPacket["records"][number] {
  return { metadata: { index, run: `run-${index}`, state: "done" }, parts };
}

function yamlCoreRoundTrip(packet: CompletionYamlPacket): string {
  const encoded = encodeCompletionYamlCarrier(packet);
  assert.equal(encoded.state, "available");
  if (encoded.state !== "available") throw new Error("Expected YAML carrier");
  const decoded = readCompletionYamlCarrier(encoded.text);
  assert.equal(decoded.state, "available");
  if (decoded.state !== "available") throw new Error("Expected decoded carrier");
  assert.deepEqual(decoded.packet, packet);
  let cursor = 0;
  for (const block of decoded.blocks) {
    assert.equal(block.start, cursor);
    assert.ok(block.end >= block.start);
    cursor = block.end;
    if (block.kind === "body" || block.kind === "marker") {
      assert.equal(encoded.text.slice(block.start, block.end), Object.values(packet.records[block.record]!.parts[block.part!]!)[0]);
    }
  }
  assert.equal(cursor, encoded.text.length);
  return encoded.text;
}

test("unadmitted YAML core body presence governs single, adjacent bare, mixed and all-omitted framing", () => {
  const bare = yamlCoreRoundTrip({ batchId: "unique-packet-id", records: [yamlCoreRow()] });
  assert.ok(bare.startsWith('index: 0\nrun: "run-0"\nstate: "done"\n'));
  assert.ok(!bare.includes("---"));
  assert.equal(bare.split("unique-packet-id").length - 1, 1);
  const empty = yamlCoreRoundTrip({ batchId: "empty", records: [yamlCoreRow(0, [{ body: "" }])] });
  assert.ok(empty.startsWith("---\n"));
  assert.ok(empty.endsWith("---\n"));
  assert.match(empty, /body: 0/u);
  for (const count of [1, 2]) {
    const parts = Array.from({ length: count }, () => ({ marker: "" }));
    assert.equal(encodeCompletionYamlCarrier({ batchId: "empty-markers", records: [yamlCoreRow(0, parts)] }).state, "unavailable");
    const donor = yamlCoreRoundTrip({ batchId: "empty-bodies", records: [yamlCoreRow(0, parts.map(() => ({ body: "" })))] });
    assert.equal(readCompletionYamlCarrier(donor.replaceAll("- body: 0", "- marker: 0")).state, "unavailable");
  }
  for (const parts of [[{ marker: "[omitted: unknown]" }], [{ marker: "" }, { marker: "Visible compiler explanation" }]]) {
    assert.ok(yamlCoreRoundTrip({ batchId: "marker-explanation", records: [yamlCoreRow(0, parts)] }).startsWith("---\n"));
  }
  for (const tail of ["", "x", "\r", "\n", "\r\n", "😀", "\uFEFF"]) {
    yamlCoreRoundTrip({ batchId: "mixed", records: [yamlCoreRow(), yamlCoreRow(1), yamlCoreRow(2, [{ body: tail }]), yamlCoreRow(3),
      yamlCoreRow(4, [{ body: "a" }, { marker: "[omitted: unknown]" }, { body: tail }]), yamlCoreRow(5, [{ body: "" }])] });
  }
  const omitted = yamlCoreRoundTrip({ batchId: "omitted", records: [], service: { omitted: 65, inventory: { path: "/whole/path", total: 65 }, unavailability: [] } });
  assert.ok(omitted.startsWith("_completion:\n"));
  assert.ok(!omitted.includes("---"));
  assert.equal(encodeCompletionYamlCarrier({ batchId: "empty", records: [] }).state, "unavailable");
  const local = { run: "only", state: "done" }, serviceV2 = { header_layout: "rooted_files_v2" };
  for (const parts of [[], [{ body: "" }], [{ marker: "[omitted: unknown]" }],
    [{ body: 'index: 99\nBatch: `authored`\r\n---\n😀' }]]) {
    const packet = { batchId: "local-singleton", records: [{ metadata: local, parts }], service: serviceV2 };
    const text = yamlCoreRoundTrip(packet);
    assert.ok(text.startsWith(parts.length ? '---\nrun: "only"\nstate: "done"\n' : 'run: "only"\nstate: "done"\n'));
    for (const invalid of [text.replace("rooted_files_v2", "rooted_files_v1"),
      text.replace('run: "only"\nstate:', 'index: 0\nrun: "only"\nstate:')]) {
      assert.equal(readCompletionYamlCarrier(invalid).state, "unavailable");
    }
    for (const service of [undefined, { header_layout: "rooted_files_v1" }, { header_layout: "rooted_files_v3" },
      { ...serviceV2, numbering: { kind: "stream" } }]) {
      assert.equal(encodeCompletionYamlCarrier({ ...packet, service }).state, "unavailable");
    }
    assert.equal(encodeCompletionYamlCarrier({ ...packet, records: [...packet.records, ...packet.records] }).state, "unavailable");
    assert.equal(encodeCompletionYamlCarrier({ ...packet, records: [{ metadata: { index: 0, ...local }, parts }] }).state, "unavailable");
  }
  // An unadmitted DTO's numbering hint is never packet-local singleton presentation.
  yamlCoreRoundTrip({ batchId: "scoped", records: [yamlCoreRow(41)], service: { ...serviceV2, numbering: { kind: "stream" } } });
  const sameBody = [{ body: "same exact body" }];
  const a = yamlCoreRoundTrip({ batchId: "epoch-a", records: [yamlCoreRow(0, sameBody)] });
  const b = yamlCoreRoundTrip({ batchId: "epoch-b", records: [yamlCoreRow(0, sameBody)] });
  assert.notEqual(a, b); // Distinct data, not authenticated identities.
});

test("unadmitted YAML core preserves nested native nodes, scalar keys and literal body lookalikes", () => {
  const metadata = JSON.parse('{"references":{"__proto__":{"constructor":{"prototype":"not authority"}},"then":"data","toJSON":"data","﻿key":"BOM key","empty_list":[],"empty_map":{},"scalar":[null,true,1,"?","---","a\\r\\nb\\n","quoted JSON: {\\"x\\":1}"]}}');
  let nested: Record<string, unknown> = metadata;
  for (let i = 0; i < 12; i++) { nested.child = {}; nested = nested.child as Record<string, unknown>; }
  const body = '\uFEFF---\r\nindex: 99\n_completion:\n  codec: "completion_yaml_core_v1"\n  parts:\n    - body: 1\n---\n<!-- pi-actors runtime -->\n```yaml\nnext:\n- tool: inspect\n{ "capture": "opaque" }\n[3 characters omitted]\n';
  const row = yamlCoreRow(0, [{ body }, { marker: "[omitted: unknown]" }, { body: "\r\n😀" }]);
  row.metadata = { ...metadata, kind: "diagnostic", state: "failed", run: "literal\r\nrun", index: "?" };
  const text = yamlCoreRoundTrip({ batchId: "native", records: [row, yamlCoreRow(1)] });
  assert.ok(text.startsWith('---\nindex: "?"\nrun: "literal\\r\\nrun"\nstate: "failed"\nkind: "diagnostic"\nreferences:\n'));
  assert.ok(text.includes(body));
  assert.ok(text.includes('"﻿key": "BOM key"'));
});

test("unadmitted YAML core enforces whole UTF8 packet and shown-row boundaries without clipping", () => {
  const rows = Array.from({ length: 64 }, (_, index) => yamlCoreRow(index));
  yamlCoreRoundTrip({ batchId: "max-rows", records: rows });
  assert.equal(encodeCompletionYamlCarrier({ batchId: "over-rows", records: [...rows, yamlCoreRow(64)] }).state, "unavailable");
  for (const scalar of ["x", "é", "😀"]) {
    let low = 0, high = 49153;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      const result = encodeCompletionYamlCarrier({ batchId: "fit", records: [yamlCoreRow(0, [{ body: scalar.repeat(mid) }])] });
      if (result.state === "available") low = mid; else high = mid;
    }
    const base = { batchId: "fit", records: [yamlCoreRow(0, [{ body: scalar.repeat(low) }])] };
    const initial = yamlCoreRoundTrip(base);
    const padding = 49152 - Buffer.byteLength(initial, "utf8");
    base.records[0]!.parts = [{ body: scalar.repeat(low) + "x".repeat(padding) }];
    const exact = yamlCoreRoundTrip(base);
    assert.equal(Buffer.byteLength(exact, "utf8"), 49152);
    base.records[0]!.parts = [{ body: scalar.repeat(low) + "x".repeat(padding + 1) }];
    assert.equal(encodeCompletionYamlCarrier(base).state, "unavailable");
    assert.equal(readCompletionYamlCarrier(exact + "x").state, "unavailable");
  }
});

test("unadmitted YAML core refuses descriptors, hooks, cycles and unsafe prototypes without invocation", () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error("Must not invoke"); };
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, "secret", { get: hook, enumerable: true });
  const nonenum = Object.defineProperty({}, "secret", { value: "hidden" });
  const values = [getter, nonenum, { [Symbol("hidden")]: 1 }, cycle, Object.create({ inherited: 1 }), new Date(),
    { toJSON: hook }, { then: hook }, new Proxy({}, { ownKeys: hook }), [,,], Object.assign([], { extra: 1 }),
    "\ud800", -0, Infinity, NaN, undefined, 1n];
  for (const value of values) {
    const row = yamlCoreRow();
    const input = { batchId: "hostile", records: [{ ...row, metadata: { ...row.metadata, selected: value } }] };
    assert.equal(encodeCompletionYamlCarrier(input).state, "unavailable");
  }
  for (const input of [getter, nonenum, { batchId: "x", records: [], extra: 1 }, { batchId: "x", records: [yamlCoreRow()], service: {} },
    { batchId: "x", records: [{ metadata: { index: 0, run: "x", state: "done", _completion: {} }, parts: [] }] },
    { batchId: "x", records: [{ ...yamlCoreRow(), parts: [{ body: "a", marker: "b" }] }] }]) {
    assert.equal(encodeCompletionYamlCarrier(input).state, "unavailable");
  }
  assert.equal(readCompletionYamlCarrier({ toString: hook }).state, "unavailable");
  assert.equal(calls, 0);
  const frozen = Object.freeze({ batchId: "frozen", records: Object.freeze([Object.freeze({ metadata: Object.freeze({ index: 0, run: "x", state: "done" }), parts: Object.freeze([]) })]) });
  assert.equal(encodeCompletionYamlCarrier(frozen).state, "available");
});

test("unadmitted YAML core rejects malformed whole frames and never promotes body lookalikes", () => {
  const source = yamlCoreRoundTrip({ batchId: "valid-id", records: [yamlCoreRow(0, [{ body: "😀\r\n---\nindex: forged\n---\n" }]), yamlCoreRow(1), yamlCoreRow(2)] });
  const invalid = ["", "\uFEFF" + source, source + "trailing", source + "\n", source.replace('batch_id: "valid-id"\n', ""),
    source.replace('batch_id: "valid-id"', 'batch_id: "valid-id"\n  batch_id: "dupe"'), source.replace('batch_id: "valid-id"', 'batch_id: ""'),
    source.replace("completion_yaml_core_v1", "unknown"), source.replace("  parts:\n", "  extra: true\n  parts:\n"),
    source.replace(/body: \d+/u, "body: -1"), source.replace(/body: \d+/u, "body: 1"), source.replace(/body: \d+/u, "body: 999999"),
    source.replace(/body: \d+/u, "body: 2\n      marker: 0"), source.replace(/body: \d+/u, 'body: "1"'),
    source.replace('run: "run-0"', 'run: !!str "run-0"'), source.replace('run: "run-0"', 'run: &anchor "run-0"'),
    source.replace('run: "run-0"', 'run: ["run-0"]'), source.replace('run: "run-0"', 'run: {x: "run-0"}'),
    source.replace('index: 0\nrun: "run-0"', 'run: "run-0"\nindex: 0'), source.replace('state: "done"\n', ''),
    source.replace('\n\nindex: 1', '\nindex: 1'), source.replace('\n\nindex: 2', '\n\n\nindex: 2'),
    source.replace('index: 2\nrun: "run-2"', 'index: 2\nrun: "run-2"\n_completion:\n  batch_id: "again"')];
  for (const text of invalid) assert.equal(readCompletionYamlCarrier(text).state, "unavailable", JSON.stringify(text));
  // Header-shaped authored text is content at the declared cursor. This checks
  // consistency only; a coherently rewritten packet is not authenticated.
  const one = yamlCoreRoundTrip({ batchId: "body-only", records: [yamlCoreRow(0, [{ body: '---\nindex: 1\nrun: "forged"\nstate: "done"\n---\n' }])] });
  const parsed = readCompletionYamlCarrier(one);
  assert.ok(parsed.state === "available" && parsed.packet.records.length === 1);
});

test("unadmitted YAML core cursor properties cover 64 independent bodies and malformed partition descriptors", () => {
  const literals = ["", "\r", "\r\n", "\n", "😀", "\uFEFF", "---\nnext:\n", "<!-- owned? -->", "```\n", "[5 characters omitted]"];
  for (let seed = 0; seed < 10; seed++) {
    const records = Array.from({ length: 64 }, (_, index) => yamlCoreRow(index, [
      { body: literals[(index + seed) % literals.length]! }, { marker: literals[(index * 3 + seed) % literals.length]! },
      { body: literals[(index * 7 + seed) % literals.length]! },
    ]));
    const text = yamlCoreRoundTrip({ batchId: `cursor-${seed}`, records, service: { omitted: 192, inventory: { total: 256 } } });
    assert.equal(text.split(`cursor-${seed}`).length - 1, 1);
    for (const row of records) assert.ok(text.includes(`index: ${row.metadata.index}\nrun: "${row.metadata.run}"\nstate: "done"\n`));
  }
  for (const row of [
    { metadata: { index: 0, run: "r", state: "done", "0": "cannot precede core" }, parts: [] },
    { metadata: { index: 0, run: "r", state: "done" } },
    { metadata: { index: 0, run: "r", state: "done" }, parts: [{ body: "\ud83d" }, { body: "\ude00" }] },
    { metadata: { index: 0, run: "r", state: "done" }, parts: [{ body: 0 }] },
    { metadata: { index: 0, run: "r", state: "done" }, parts: [{ body: "x", start: 0 }] },
  ]) assert.equal(encodeCompletionYamlCarrier({ batchId: "bad", records: [row] }).state, "unavailable");
  const wire = yamlCoreRoundTrip({ batchId: "split", records: [yamlCoreRow(0, [{ body: "😀" }, { body: "x" }])] });
  assert.equal(readCompletionYamlCarrier(wire.replace("body: 2\n    - body: 1", "body: 1\n    - body: 2")).state, "unavailable");
  const bare = yamlCoreRoundTrip({ batchId: "extra", records: [yamlCoreRow()] });
  for (const bad of [bare + "---\n", bare.replace("_completion:\n", "_completion:\n  parts: []\n"),
    bare.replace("_completion:\n", "_completion:\n  service: {}\n"), bare.replace("index: 0", "index: ?"),
    bare.replace('run: "run-0"', 'run: *missing'), bare.replace('run: "run-0"', 'run: !custom "run-0"')]) {
    assert.equal(readCompletionYamlCarrier(bad).state, "unavailable");
  }
});

function yamlProjectionFixture(members: RunCompletionBatchMember[] = [{ ...member("projection"), summary: "Run completed.", artifacts: undefined, output: "opaque" }]): deliveryYamlPrototype.RunCompletionBatch {
  return { batch_id: "projection", created_at: "2026-08-31T12:00:00.000Z", phase: "pending", presentation_format: "ax_records", result_layout: "frontmatter_v2", members };
}

test("unadmitted YAML projection exposes only a pure nondefault projection", () => {
  const api = deliveryYamlPrototype as unknown as Record<string, Function>;
  assert.equal(typeof api.projectRunCompletionYamlPrototype, "function", "pure fitted YAML projection is missing");
  const input = yamlProjectionFixture(), before = JSON.stringify(input);
  const result = api.projectRunCompletionYamlPrototype!(input);
  assert.equal(result.state, "available");
  assert.equal(result.membersShown, 1);
  assert.equal(typeof result.textBudget, "number");
  assert.deepEqual(result.presentation, { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(result.content).digest("hex") });
  assert.equal(readCompletionYamlCarrier(result.content).state, "available");
  assert.equal(JSON.stringify(input), before);
});

function yamlProjected(batch: unknown) {
  const result = deliveryYamlPrototype.projectRunCompletionYamlPrototype(batch);
  assert.equal(result.state, "available", JSON.stringify(result));
  if (result.state !== "available") throw new Error("Expected fitted YAML projection");
  const decoded = readCompletionYamlCarrier(result.content);
  assert.equal(decoded.state, "available");
  if (decoded.state !== "available") throw new Error("Expected decoded YAML projection");
  return { ...result, packet: decoded.packet };
}

test("unadmitted YAML projection bridges typed source families and exact native navigation without IO", async () => {
  const { describeRunArtifactReferences } = await import("../lib/runs-artifacts.ts");
  const { collectRunCompletionBatchMembers } = await import("../lib/observability.ts");
  const { artifacts: _unused, ...base } = member("native");
  const primary = { ...base, summary: "Run completed.", primary_text: primaryBinding(base, "primary body", ""),
    ...diagnosticBinding(base, "secondary diagnostic", ""), artifact_inventory: {
      source: { path: join(base.state_dir, "evidence", `artifact-inventory-${"b".repeat(64)}.json`), run_instance_id: base.run_instance_id, sha256: "b".repeat(64) },
      bytes_total: 500, declarations_total: 123 } };
  const diagnostic = { ...member("diagnostic"), artifacts: undefined, status: "failed" as const, summary: "Run failed.", ...diagnosticBinding(member("diagnostic"), "diagnostic body", "") };
  const names = ["0", "__proto__", "\uFEFFname", "世界"], artifacts = Object.fromEntries(names.map(name => [name, `/whole/${name}`]));
  artifacts[names[3]!] = "/tmp/\ud800";
  assert.equal(describeRunArtifactReferences(artifacts, "/tmp").state, "available");
  const transition = { run: "declared", runInstanceId: "generation-declared", stateDir: fixtureStateDir("declared"),
    from: "running", to: "done", terminalAt: base.terminal_at, artifacts };
  const collected = collectRunCompletionBatchMembers([transition as Parameters<typeof collectRunCompletionBatchMembers>[0][number]]);
  assert.equal(collected.length, 1);
  const child = { ...collected[0]!, parent_run: primary.run, parent_run_instance_id: primary.run_instance_id, parent_state_dir: primary.state_dir };
  const batch = { ...yamlProjectionFixture([primary, diagnostic, child]), text_budget: 6000, navigation_handoff: "captured_file_locations" as const,
    file_navigation: capturedLocations([primary, diagnostic, child]) };
  const before = JSON.stringify(batch), savedRead = fs.readFileSync, savedStat = fs.lstatSync;
  try {
    fs.readFileSync = (() => { throw new Error("No projection IO"); }) as typeof fs.readFileSync;
    fs.lstatSync = (() => { throw new Error("No projection IO"); }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    const result = yamlProjected(batch), rows = result.packet.records;
    const primaryRow = rows.find(row => row.metadata.run === "native")!;
    assert.deepEqual(Object.keys(primaryRow.metadata).slice(0, 4), ["index", "run", "state", "kind"]);
    assert.equal(primaryRow.metadata.kind, "primary");
    assert.equal(primaryRow.metadata.redacted, true);
    assert.equal(primaryRow.metadata.artifact_declarations, 123);
    const refs = primaryRow.metadata.references as Record<string, any>;
    assert.equal(refs.primary.source.path, primary.primary_text.output.source.path);
    assert.equal(refs.primary.redacted, true);
    for (const key of ["state", "chars_shown", "chars_total", "utf8_range", "upstream_truncated"]) assert.equal(key in refs.primary, false);
    assert.equal("secondary_diagnostic_excerpt" in refs, false);
    assert.equal(refs.diagnostic_metadata.source.fields.length, 2);
    assert.equal(JSON.stringify(primaryRow).includes("secondary diagnostic"), false);
    assert.deepEqual(primaryRow.metadata.run_files, { run: primary.run, run_instance_id: primary.run_instance_id, locations: batch.file_navigation[0].locations });
    const declarationRow = rows.find(row => row.metadata.run === "declared")!;
    assert.equal(declarationRow.metadata.parent_run, "native");
    const declarations = (declarationRow.metadata.references as any).artifacts.declarations;
    assert.deepEqual(declarations.map((item: any) => item.name), names);
    assert.deepEqual(declarations[3].path, { utf16_code_units: "002f 0074 006d 0070 002f d800" });
    assert.equal(String.fromCharCode(...declarations[3].path.utf16_code_units.split(" ").map((unit: string) => parseInt(unit, 16))), artifacts[names[3]!]);
    assert.equal(rows.find(row => row.metadata.run === "diagnostic")!.metadata.kind, "diagnostic");
    assert.equal(JSON.stringify(batch), before);
  } finally { fs.readFileSync = savedRead; fs.lstatSync = savedStat; syncBuiltinESMExports(); }
});

test("unadmitted YAML projection preserves independent opaque body pieces, presence and uncertainty", () => {
  const body = '\uFEFF---\r\nindex: forged\n<!-- private? -->\n```yaml\nnext:\n  tool: inspect\n{ "x": 1 }\n';
  const base = { ...member("opaque-projection"), artifacts: undefined, summary: "summary source" };
  const input = { ...base, primary_text: { output: { ...primaryBinding(base, body, "TAIL").output, text_basis: "actor_response" as const, upstream_truncated: true } } };
  const projected = yamlProjected({ ...yamlProjectionFixture([input]), text_budget: 4000 });
  const row = projected.packet.records[0]!;
  assert.deepEqual(row.parts, [{ body: "summary source" }, { marker: "\n" }, { body }, { marker: "\n" }, { marker: "[4 characters omitted]" },
    { marker: "\n" }, { marker: "[omitted: unknown] (upstream completeness unproven)" }, { marker: "\n" },
    { marker: "[omitted: unknown] (summary/fallback text: original completeness/privacy unproven)" }]);
  const ordinary = { ...base, summary: "Run completed.", output: undefined };
  assert.deepEqual(yamlProjected(yamlProjectionFixture([ordinary])).packet.records[0]!.parts, []);
  const empty = { ...ordinary, primary_text: primaryBinding(ordinary, "", "") };
  assert.deepEqual(yamlProjected(yamlProjectionFixture([empty])).packet.records[0]!.parts, [{ body: "" }]);
  const malformed = { ...ordinary, output: "bad\ud800" };
  const markerOnly = yamlProjected(yamlProjectionFixture([malformed])).packet.records[0]!;
  assert.equal(markerOnly.parts.some(part => "body" in part), false);
  assert.match(JSON.stringify(markerOnly.parts), /malformed retained text/u);
  assert.equal(JSON.stringify(markerOnly).includes("utf16_code_units"), false);
  assert.equal("kind" in markerOnly.metadata, false);
  assert.equal(yamlProjected(yamlProjectionFixture([{ ...ordinary, output: "fallback" }])).packet.records[0]!.metadata.kind, undefined);
});

test("unadmitted YAML projection keeps frozen shares and retained prefixes without redistribution", () => {
  const make = (run: string, text: string) => {
    const item = { ...member(run), artifacts: undefined, summary: "Run completed." };
    return { ...item, primary_text: primaryBinding(item, text, ""), completion_text: { text, shown_bytes: { start: 0, end: Buffer.byteLength(text) } } };
  };
  const full = make("long", "a😀\r\n".repeat(1000)), short = make("short", "ok");
  const retained = { ...full, completion_text: { text: "a😀", shown_bytes: { start: 0, end: 5 } } };
  const batch = { ...yamlProjectionFixture([retained, short]), text_budget: 100 };
  const before = JSON.stringify(batch), result = yamlProjected(batch);
  assert.equal(result.textBudget, 100);
  assert.equal((result.packet.records.find(row => row.metadata.run === "long")!.parts[0] as { body: string }).body, "a😀");
  assert.equal(result.content.includes(`[${[...full.completion_text.text].length - 2} characters omitted]`), true);
  assert.equal(JSON.stringify(batch), before);
  const prospective = yamlProjected(yamlProjectionFixture([full, short]));
  assert.equal(prospective.textBudget, Math.floor(49152 / 2));
  const frozenZero = yamlProjected({ ...yamlProjectionFixture([full, short]), text_budget: 0 });
  assert.equal(frozenZero.textBudget, 0);
  assert.ok(frozenZero.packet.records.every(row => (row.parts[0] as { body: string }).body === ""));
});

test("unadmitted YAML projection preserves numbering scope, omission service and bounded captured rows", () => {
  const members = Array.from({ length: 256 }, (_, index) => ({ ...member(`bounded-${index.toString().padStart(3, "0")}`), artifacts: undefined,
    summary: index % 4 === 0 ? "Run failed." : "Run completed.", status: index % 4 === 0 ? "failed" as const : "done" as const }));
  const batch = yamlProjectionFixture(members), result = yamlProjected(batch);
  assert.equal(result.membersShown, 64);
  assert.equal(result.packet.service!.omitted_results, 192);
  assert.deepEqual(result.packet.service!.omitted_states, { failed: 48 });
  assert.equal(typeof result.packet.service!.inventory_warning, "string");
  assert.equal("numbering" in result.packet.service!, false);
  const inventoryText = `${JSON.stringify({ schema: "run-completion-inventory-v1", batch_id: batch.batch_id, created_at: batch.created_at,
    scope: "captured_completion_members", members_total: members.length, artifacts: "not_included", diagnostics: "not_included", private_locations: "not_included",
    members: members.map(item => ({ run: item.run, run_instance_id: item.run_instance_id, status: item.status, terminal_at: item.terminal_at })) }, null, 2)}\n`;
  const digest = createHash("sha256").update(inventoryText).digest("hex");
  const inventory_source = { path: join(fixtureStateDir("inventory-owner"), `inventory-${digest}.json`), sha256: digest,
    bytes_total: Buffer.byteLength(inventoryText), members_total: members.length };
  const withInventory = yamlProjected({ ...batch, inventory_source });
  assert.deepEqual(withInventory.packet.service!.result_inventory, inventory_source);
  assert.equal("inventory_warning" in withInventory.packet.service!, false);
  assert.deepEqual(deliveryYamlPrototype.projectRunCompletionYamlPrototype(yamlProjectionFixture([...members, member("overflow")])), { state: "unavailable", reason: "invalid_snapshot" });
  const selected = members.slice(0, 3), order = [2, 0, 1];
  for (const numbering of [{ kind: "stream" as const, session_id: "session", stream_id: "12345678-1234-4234-8234-123456789abc", first_index: 99, member_order: order },
    { kind: "unavailable" as const, session_id: "session", stream_id: "12345678-1234-4234-8234-123456789abc", reason: "counter_unavailable" as const, member_order: order }]) {
    const numbered = yamlProjected({ ...yamlProjectionFixture(selected), numbering });
    assert.deepEqual(numbered.packet.service!.numbering, numbering);
    assert.deepEqual(numbered.packet.records.map(row => row.metadata.run), order.map(index => selected[index]!.run));
    assert.deepEqual(numbered.packet.records.map(row => row.metadata.index), numbering.kind === "stream" ? [99, 100, 101] : ["?", "?", "?"]);
    if (numbering.kind === "unavailable") assert.equal(numbered.packet.service!.numbering_unavailable, numbering.reason);
  }
});

test("unadmitted YAML projection refuses unsupported sources and malformed semantic core rather than repairing them", () => {
  const base = yamlProjectionFixture();
  for (const result_layout of [undefined, "records", "frontmatter_v1", "headings_shared_kinds"] as const) {
    assert.deepEqual(deliveryYamlPrototype.projectRunCompletionYamlPrototype({ ...base, result_layout }), { state: "unavailable", reason: "unsupported_source_class" });
  }
  assert.deepEqual(deliveryYamlPrototype.projectRunCompletionYamlPrototype({ ...base, batch_id: "\ud800" }), { state: "unavailable", reason: "unsupported_selected_data" });
  assert.deepEqual(deliveryYamlPrototype.projectRunCompletionYamlPrototype(yamlProjectionFixture([{ ...base.members[0]!, run: "run:\ud800" }])) , { state: "unavailable", reason: "unsupported_selected_data" });
  assert.deepEqual(deliveryYamlPrototype.projectRunCompletionYamlPrototype({ ...base, members: [] }), { state: "unavailable", reason: "invalid_snapshot" });
});

// Independent finite oracle: quotas in the same scalar-prefix interval produce
// identical parts; only that interval's greatest coordinate can win. No search.
function yamlProjectionOracle(batch: deliveryYamlPrototype.RunCompletionBatch) {
  const maximum = Math.floor(49152 / Math.min(64, batch.members.length));
  const templates = batch.members.slice(0, 64).map(item => yamlProjected({ ...yamlProjectionFixture([item]), text_budget: 0 }).packet.records[0]!.metadata);
  const coordinates = new Set([0, maximum]);
  const sourceText = (member: RunCompletionBatchMember) => member.completion_text?.text ?? member.primary_text?.output?.preview ?? member.output!;
  for (const member of batch.members) {
    let bytes = 0;
    for (const scalar of [...sourceText(member)]) {
      bytes += Buffer.byteLength(scalar);
      if (bytes <= maximum) { coordinates.add(bytes); if (bytes > 0) coordinates.add(bytes - 1); }
    }
  }
  const truncate = (text: string, quota: number) => {
    let result = "", bytes = 0;
    for (const scalar of text) { bytes += Buffer.byteLength(scalar); if (bytes > quota) break; result += scalar; }
    if (result.endsWith("\r") && text[result.length] === "\n") result = result.slice(0, -1);
    return result;
  };
  let bestShown = -1, bestQuota = -1, bestPacket: CompletionYamlPacket | undefined;
  for (const quota of [...coordinates].sort((a, b) => a - b)) for (let shown = 0; shown <= templates.length; shown++) {
    const packet: CompletionYamlPacket = { batchId: batch.batch_id, records: templates.slice(0, shown).map((metadata, index) => ({
      metadata: { ...metadata, index }, parts: (() => {
        const member = batch.members[index]!, body = truncate(sourceText(member), quota), primary = member.primary_text?.output;
        const omitted = primary ? primary.chars_total - [...body].length : undefined;
        return [{ body }, ...(primary ? omitted ? [{ marker: "\n" }, { marker: `[${omitted} characters omitted]` }] : []
          : [{ marker: "\n" }, { marker: "[omitted: unknown] (summary/fallback text: original completeness/privacy unproven)" }])];
      })(),
    })) };
    if (shown < batch.members.length) packet.service = { omitted_results: batch.members.length - shown, inventory_warning: "No inventory reference is retained in this packet." };
    if (encodeCompletionYamlCarrier(packet).state === "available" && (shown > bestShown || shown === bestShown && quota > bestQuota)) {
      bestShown = shown; bestQuota = quota; bestPacket = packet;
    }
  }
  return { membersShown: bestShown, textBudget: bestQuota, packet: bestPacket };
}

test("unadmitted YAML projection matches an exhaustive scalar-interval oracle, not a second optimizer", () => {
  for (const count of [3, 4]) {
    const members = Array.from({ length: count }, (_, index) => ({ ...member(`oracle-${index}`), summary: "Run completed.",
      output: index === 1 ? "😀\r\n".repeat(100) : "x".repeat(index === 0 ? 999 : 1000),
      artifacts: Object.fromEntries(["a", "b", "c", "d"].map(name => [name, "/" + "p".repeat(3899)])) }));
    const batch = yamlProjectionFixture(members), expected = yamlProjectionOracle(batch), actual = yamlProjected(batch);
    assert.equal(actual.membersShown, expected.membersShown);
    assert.equal(actual.textBudget, expected.textBudget);
    assert.deepEqual(actual.packet, expected.packet);
    assert.ok(actual.membersShown <= 3);
    const withLocations = yamlProjected({ ...batch, navigation_handoff: "captured_file_locations", file_navigation: capturedLocations(members) });
    assert.equal(withLocations.membersShown, actual.membersShown);
    assert.ok(withLocations.packet.records.some(row => row.parts.some(part => "marker" in part && part.marker.startsWith("Run-file reference omitted"))));
  }
  for (const count of [11, 12, 101, 102]) {
    const members = Array.from({ length: count }, (_, index) => ({ ...member(`decimal-${index.toString().padStart(3, "0")}`),
      summary: "Run completed.", output: "x", artifacts: Object.fromEntries(["a", "b", "c", "d"].map(name => [name, "/" + "p".repeat(4095)])) }));
    const batch = yamlProjectionFixture(members), expected = yamlProjectionOracle(batch), actual = yamlProjected(batch);
    assert.equal(actual.membersShown, 2);
    assert.equal(actual.packet.service!.omitted_results, count - 2);
    assert.equal(actual.textBudget, expected.textBudget);
    assert.deepEqual(actual.packet, expected.packet);
  }
  const tracked = Array.from({ length: 3 }, (_, index) => {
    const item = { ...member(`tracked-${index}`), summary: "Run completed.",
      artifacts: Object.fromEntries(["a", "b", "c", "d"].map(name => [name, "/" + "p".repeat(3799)])) };
    return { ...item, primary_text: primaryBinding(item, index === 1 ? "😀\r\n".repeat(100) : "x".repeat(999 + index), "") };
  });
  const trackedBatch = yamlProjectionFixture(tracked), trackedExpected = yamlProjectionOracle(trackedBatch), trackedActual = yamlProjected(trackedBatch);
  assert.equal(trackedActual.membersShown, trackedExpected.membersShown);
  assert.equal(trackedActual.textBudget, trackedExpected.textBudget);
  assert.deepEqual(trackedActual.packet, trackedExpected.packet);
  for (const length of [9, 10, 99, 100]) {
    const batch = yamlProjectionFixture([{ ...member("descriptor"), summary: "Run completed.", artifacts: undefined, output: "x".repeat(length) }]);
    const expected = yamlProjectionOracle(batch), actual = yamlProjected(batch);
    assert.equal(actual.textBudget, expected.textBudget);
    assert.deepEqual(actual.packet, expected.packet);
  }
});

test("unadmitted YAML projection measures exact UTF8 fit, whole-reference priority and all-omitted service", () => {
  const members = Array.from({ length: 13 }, (_, index) => ({ ...member(`exact-${index.toString().padStart(2, "0")}`), artifacts: undefined,
    summary: "Run completed.", output: "x".repeat(index === 12 ? 100 : 4000) }));
  const batch = { ...yamlProjectionFixture(members), text_budget: 3700 }, initial = yamlProjected(batch);
  assert.equal(initial.membersShown, 13);
  const oldLength = members[12]!.output.length;
  let next = oldLength + 49152 - Buffer.byteLength(initial.content);
  next -= String(next).length - String(oldLength).length;
  assert.ok(next > 0 && next < 3700);
  members[12]!.output = "x".repeat(next);
  const exact = yamlProjected(batch);
  assert.equal(exact.membersShown, 13);
  assert.equal(Buffer.byteLength(exact.content), 49152);
  const overflow = yamlProjected({ ...batch, members: members.map((item, index) => index === 12 ? { ...item, output: item.output + "x" } : item) });
  assert.ok(overflow.membersShown < 13);
  assert.equal(overflow.packet.service!.omitted_results, 13 - overflow.membersShown);
  const metadataTooLarge = { ...member("all-omitted"), summary: "Run failed.", status: "failed" as const,
    artifacts: Object.fromEntries(["a", "b", "c", "d"].map(name => [name, "\u0000".repeat(4096)])) };
  const allOmitted = yamlProjected(yamlProjectionFixture([metadataTooLarge]));
  assert.equal(allOmitted.membersShown, 0);
  assert.ok(allOmitted.content.startsWith("_completion:\n"));
  assert.ok(!allOmitted.content.includes("---"));
  assert.deepEqual(allOmitted.packet.service, { omitted_results: 1, omitted_states: { failed: 1 }, inventory_warning: "No inventory reference is retained in this packet." });
  const last = { ...member("reference"), artifacts: undefined, summary: "Run completed.", output: "body" };
  const withReference = yamlProjected({ ...yamlProjectionFixture([last]), navigation_handoff: "captured_file_locations", file_navigation: capturedLocations([last]) });
  assert.deepEqual(withReference.packet.records[0]!.metadata.run_files, { run: last.run, run_instance_id: last.run_instance_id, locations: capturedLocations([last])[0].locations });
});
