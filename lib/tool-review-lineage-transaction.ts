/**
 * Journaled tool-review lineage finalization.
 * Zones: lineage projection persistence, ledger/index CAS, crash roll-forward
 * Owns idempotent ledger mutation after portfolio filesystem commit; admission-state activation and quarantine cleanup remain separate.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as RecipesReferences from "./recipes-references.ts";
import * as RecipesUsage from "./recipes-usage.ts";
import { projectToolReviewLineage } from "./tool-review-lineage.ts";
import type {
  ToolReviewApprovedPlan,
  ToolReviewApprovedSource,
  ToolReviewApprovedTarget,
} from "./tool-review-transaction.ts";

interface LineageWrite {
  expectedSha256: string | null;
  path: string;
  sha256: string;
  value: Record<string, unknown>;
}

interface RecipeRevisionSnapshot extends Record<string, unknown> {
  content_base64: string;
  created_at: string;
  lineage_name: string;
  review_id: string;
  rollback_recipe: Record<string, unknown>;
  rollback_recipe_sha256: string;
  source_extension: string;
  source_name: string;
  source_revision: number;
  source_sha256: string;
  target_path: string;
  target_sha256: string;
  transition_action: "evolve" | "replace";
  type: "recipe_revision_snapshot";
}

interface LineageDelete {
  expectedSha256: string;
  path: string;
}

interface ToolReviewLineageJournal {
  deletes: LineageDelete[];
  operationsSha256: string;
  phase: "committed" | "prepared";
  planSha256: string;
  reviewId: string;
  updatedAt: string;
  writes: LineageWrite[];
}

export interface ToolReviewLineageTransactionResult {
  journalPath: string;
  phase: "committed";
}

export interface ToolReviewLineageTransactionOptions {
  checkpoint?(checkpoint: "ledger_written" | "prepared"): void;
  now?(): Date;
  recipeRoot: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileHash(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function recipeFingerprint(recipe: Record<string, unknown>): string {
  const { usage: _usage, ...content } = recipe;
  return sha256(canonicalJson(content));
}

function pathKey(path: string, recipeRoot: string): string {
  return relative(resolve(recipeRoot), resolve(path)).replaceAll("\\", "/");
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function unique(values: string[], limit = 128): string[] {
  return [...new Set(values)].slice(-limit);
}

function sourceRecord(
  source: ToolReviewApprovedSource,
  recipeRoot: string,
): Record<string, unknown> {
  const record = RecipesUsage.readRecipeUsage(source.path, recipeRoot);
  if (!record || typeof record.lineage_name !== "string") {
    throw new Error(`Missing tool review lineage source: ${source.name}`);
  }
  return record;
}

function reviewedRecord(
  source: Record<string, unknown>,
  reviewId: string,
  now: string,
): Record<string, unknown> {
  const fingerprint = String(source.fingerprint ?? "");
  return {
    ...source,
    lineage_events: [
      ...(Array.isArray(source.lineage_events) ? source.lineage_events : []),
      { at: now, review_epoch: reviewId, type: "reviewed" },
    ].slice(-128),
    review_epochs: unique([...strings(source.review_epochs), reviewId]),
    reviewed_fingerprints: unique([
      ...strings(source.reviewed_fingerprints),
      fingerprint,
    ]),
  };
}

function continuedRecord(
  records: Record<string, unknown>[],
  target: ToolReviewApprovedTarget,
  action: "demote" | "evolve" | "merge" | "split",
  reviewId: string,
  now: string,
  recipeRoot: string,
): Record<string, unknown> {
  const primary = records[0]!;
  const fingerprint = recipeFingerprint(target.recipe);
  const lifetimeCalls = records.reduce(
    (total, record) => total + count(record.lifetime_calls ?? record.calls),
    0,
  );
  const changed = records.length > 1 || primary.fingerprint !== fingerprint;
  const revision = Math.max(...records.map((record) => count(record.revision) || 1)) + (changed ? 1 : 0);
  const formerNames = unique(
    records.flatMap((record) => [
      ...strings(record.former_names),
      String(record.lineage_name ?? ""),
    ]).filter((name) => name && name !== target.name),
  );
  const formerPaths = unique(
    records.flatMap((record) => [
      ...strings(record.former_paths),
      String(record.current_path ?? ""),
    ]).filter(Boolean),
  );
  const revisions = records.flatMap((record) =>
    Array.isArray(record.revisions) ? record.revisions : [],
  );
  const {
    demoted_at: _demotedAt,
    demoted_fingerprint: _demotedFingerprint,
    demoted_from_revision: _demotedFromRevision,
    demoted_review_epoch: _demotedReviewEpoch,
    rollback_of_revision: _rollbackOfRevision,
    ...base
  } = primary;
  return {
    ...base,
    calls: lifetimeCalls,
    current_path: pathKey(target.path, recipeRoot),
    ...(action === "demote"
      ? {
          demoted_at: now,
          demoted_fingerprint: fingerprint,
          demoted_from_revision: count(primary.revision) || 1,
          demoted_review_epoch: reviewId,
        }
      : {}),
    fingerprint,
    former_names: formerNames,
    former_paths: formerPaths,
    lifetime_calls: lifetimeCalls,
    lineage_events: [
      ...records.flatMap((record) =>
        Array.isArray(record.lineage_events) ? record.lineage_events : [],
      ),
      {
        at: now,
        from: records.map((record) => String(record.lineage_name)).join(","),
        review_epoch: reviewId,
        to: target.name,
        type: action,
      },
    ].slice(-128),
    lineage_name: target.name,
    review_epochs: unique([
      ...records.flatMap((record) => strings(record.review_epochs)),
      reviewId,
    ]),
    reviewed_fingerprints: unique([
      ...records.flatMap((record) => strings(record.reviewed_fingerprints)),
      fingerprint,
    ]),
    revision,
    revision_calls: changed ? 0 : count(primary.revision_calls),
    revision_direct_calls: changed ? 0 : count(primary.revision_direct_calls),
    revision_spawn_calls: changed ? 0 : count(primary.revision_spawn_calls),
    revision_tool_calls: changed ? 0 : count(primary.revision_tool_calls),
    revisions: [
      ...revisions,
      ...(changed ? [{ fingerprint, first_seen: now, revision }] : []),
    ].slice(-128),
  };
}

function replacementRecord(
  target: ToolReviewApprovedTarget,
  reviewId: string,
  now: string,
  recipeRoot: string,
): Record<string, unknown> {
  const fingerprint = recipeFingerprint(target.recipe);
  return {
    calls: 0,
    current_path: pathKey(target.path, recipeRoot),
    fingerprint,
    first_seen: now,
    former_names: [],
    former_paths: [],
    lifetime_calls: 0,
    lineage_events: [
      { at: now, review_epoch: reviewId, to: target.name, type: "replaced" },
    ],
    lineage_name: target.name,
    review_epochs: [reviewId],
    reviewed_fingerprints: [fingerprint],
    revision: 1,
    revision_calls: 0,
    revision_direct_calls: 0,
    revision_spawn_calls: 0,
    revision_tool_calls: 0,
    revisions: [{ fingerprint, first_seen: now, revision: 1 }],
  };
}

function readIndex(recipeRoot: string): Record<string, unknown> {
  const path = RecipesUsage.getRecipeUsageIndexPath(recipeRoot);
  if (!existsSync(path)) return { paths: {} };
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid recipe usage index.");
  }
  return value as Record<string, unknown>;
}

function revisionSnapshot(
  approvedPath: string,
  plan: ToolReviewApprovedPlan,
  source: ToolReviewApprovedSource,
  sourceRecord: Record<string, unknown>,
  target: ToolReviewApprovedTarget,
  now: string,
): RecipeRevisionSnapshot {
  const transactionPath = join(dirname(approvedPath), "journal.json");
  const transaction = JSON.parse(readFileSync(transactionPath, "utf8")) as {
    operations?: {
      sources?: Array<{ original?: string; quarantine?: string; sha256?: string }>;
    };
    phase?: unknown;
  };
  const operation = transaction.operations?.sources?.find(
    (candidate) => resolve(String(candidate.original)) === resolve(source.path),
  );
  if (
    transaction.phase !== "committed" ||
    !operation ||
    operation.sha256 !== source.sha256 ||
    typeof operation.quarantine !== "string" ||
    !existsSync(operation.quarantine)
  ) {
    throw new Error(`Missing committed rollback source: ${source.name}`);
  }
  const bytes = readFileSync(operation.quarantine);
  if (sha256(bytes) !== source.sha256) {
    throw new Error(`Changed committed rollback source: ${source.name}`);
  }
  const rollbackRecipe = RecipesReferences.readRawRecipeConfig(
    operation.quarantine,
  );
  if (!rollbackRecipe || !Object.hasOwn(rollbackRecipe, "template")) {
    throw new Error(`Invalid committed rollback source: ${source.name}`);
  }
  return {
    content_base64: bytes.toString("base64"),
    created_at: now,
    lineage_name: target.name,
    review_id: plan.reviewId,
    rollback_recipe: rollbackRecipe,
    rollback_recipe_sha256: sha256(canonicalJson(rollbackRecipe)),
    source_extension: extname(source.path).toLowerCase(),
    source_name: source.name,
    source_revision: count(sourceRecord.revision) || 1,
    source_sha256: source.sha256,
    target_path: resolve(target.path),
    target_sha256: sha256(`${JSON.stringify(target.recipe, null, 2)}\n`),
    transition_action: source.action === "replace" ? "replace" : "evolve",
    type: "recipe_revision_snapshot",
  };
}

function deriveJournal(
  approvedPath: string,
  plan: ToolReviewApprovedPlan,
  recipeRoot: string,
  now: string,
): ToolReviewLineageJournal {
  const operations = projectToolReviewLineage(plan);
  const index = readIndex(recipeRoot);
  const indexPaths = {
    ...((index.paths && typeof index.paths === "object" && !Array.isArray(index.paths))
      ? index.paths as Record<string, string>
      : {}),
  };
  const desiredLedgers = new Map<string, Record<string, unknown>>();
  const revisionSnapshots = new Map<string, RecipeRevisionSnapshot>();
  const sourceLedgerPaths = new Set<string>();
  for (const operation of operations) {
    const records = operation.sources.map((source) => sourceRecord(source, recipeRoot));
    for (const record of records) {
      const lineageName = String(record.lineage_name);
      sourceLedgerPaths.add(
        RecipesUsage.getRecipeUsageLedgerPath(lineageName, recipeRoot),
      );
      delete indexPaths[String(record.current_path)];
    }
    if (operation.action === "keep") {
      const record = reviewedRecord(records[0]!, plan.reviewId, now);
      desiredLedgers.set(
        RecipesUsage.getRecipeUsageLedgerPath(String(record.lineage_name), recipeRoot),
        record,
      );
      indexPaths[String(record.current_path)] = String(record.lineage_name);
      continue;
    }
    if (operation.action === "replace") {
      const target = operation.targets[0];
      const snapshot = revisionSnapshot(
        approvedPath,
        plan,
        operation.sources[0],
        records[0]!,
        target,
        now,
      );
      revisionSnapshots.set(
        RecipesUsage.getRecipeRevisionSnapshotPath(
          target.name,
          snapshot.source_revision,
          recipeRoot,
        ),
        snapshot,
      );
      const record = replacementRecord(target, plan.reviewId, now, recipeRoot);
      desiredLedgers.set(
        RecipesUsage.getRecipeUsageLedgerPath(target.name, recipeRoot),
        record,
      );
      indexPaths[pathKey(target.path, recipeRoot)] = target.name;
      continue;
    }
    for (const target of operation.targets) {
      if (operation.action === "evolve") {
        const snapshot = revisionSnapshot(
          approvedPath,
          plan,
          operation.sources[0],
          records[0]!,
          target,
          now,
        );
        revisionSnapshots.set(
          RecipesUsage.getRecipeRevisionSnapshotPath(
            target.name,
            snapshot.source_revision,
            recipeRoot,
          ),
          snapshot,
        );
      }
      const record = continuedRecord(
        records,
        target,
        operation.action,
        plan.reviewId,
        now,
        recipeRoot,
      );
      desiredLedgers.set(
        RecipesUsage.getRecipeUsageLedgerPath(target.name, recipeRoot),
        record,
      );
      indexPaths[pathKey(target.path, recipeRoot)] = target.name;
    }
  }
  const writes: LineageWrite[] = [...desiredLedgers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => ({
      expectedSha256: fileHash(path),
      path,
      sha256: sha256(`${JSON.stringify(value, null, 2)}\n`),
      value,
    }));
  for (const [path, value] of [...revisionSnapshots.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const existing = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      : undefined;
    if (
      existing &&
      canonicalJson(existing) !== canonicalJson(value) &&
      !(
        value.transition_action === "replace" ||
        (
          existing.type === "recipe_revision_snapshot" &&
          count(existing.source_revision) <=
            value.source_revision - RecipesUsage.RECIPE_REVISION_SNAPSHOT_LIMIT
        )
      )
    ) {
      throw new Error(`Recipe revision snapshot collision: ${path}`);
    }
    writes.push({
      expectedSha256: fileHash(path),
      path,
      sha256: sha256(`${JSON.stringify(value, null, 2)}\n`),
      value,
    });
  }
  const deletes: LineageDelete[] = [...sourceLedgerPaths]
    .filter((path) => !desiredLedgers.has(path) && existsSync(path))
    .sort()
    .map((path) => ({ expectedSha256: fileHash(path)!, path }));
  const indexPath = RecipesUsage.getRecipeUsageIndexPath(recipeRoot);
  const nextIndex = { ...index, paths: indexPaths };
  writes.push({
    expectedSha256: fileHash(indexPath),
    path: indexPath,
    sha256: sha256(`${JSON.stringify(nextIndex, null, 2)}\n`),
    value: nextIndex,
  });
  const journal = {
    deletes,
    operationsSha256: "",
    phase: "prepared" as const,
    planSha256: sha256(canonicalJson(plan)),
    reviewId: plan.reviewId,
    updatedAt: now,
    writes,
  };
  journal.operationsSha256 = sha256(canonicalJson({ deletes, writes }));
  return journal;
}

function assertContainedUsagePath(path: string, usageRoot: string): void {
  const relation = relative(resolve(usageRoot), resolve(path));
  if (!relation || relation === ".." || relation.startsWith("../") || relation.startsWith("..\\")) {
    throw new Error(`Tool review lineage path escapes usage root: ${path}`);
  }
  let current = resolve(usageRoot);
  if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
    throw new Error(`Invalid tool review lineage root: ${current}`);
  }
  for (const segment of relation.split(/[\\/]/u)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in tool review lineage: ${current}`);
    }
  }
}

function validateJournal(
  journal: ToolReviewLineageJournal,
  plan: ToolReviewApprovedPlan,
  recipeRoot: string,
): void {
  if (
    journal.reviewId !== plan.reviewId ||
    journal.planSha256 !== sha256(canonicalJson(plan)) ||
    journal.operationsSha256 !==
      sha256(canonicalJson({ deletes: journal.deletes, writes: journal.writes }))
  ) {
    throw new Error("Invalid tool review lineage journal.");
  }
  const indexPath = RecipesUsage.getRecipeUsageIndexPath(recipeRoot);
  const usageRoot = dirname(indexPath);
  const allowedWrites = new Set<string>([
    indexPath,
    ...plan.sources
      .filter((source) => source.action === "keep")
      .map((source) => RecipesUsage.getRecipeUsageLedgerPath(source.name, recipeRoot)),
    ...plan.targets.map((target) =>
      RecipesUsage.getRecipeUsageLedgerPath(target.name, recipeRoot),
    ),
  ].map((path) => resolve(path)));
  const allowedDeletes = new Set<string>(
    plan.sources
      .filter((source) => source.action !== "keep")
      .map((source) => RecipesUsage.getRecipeUsageLedgerPath(source.name, recipeRoot))
      .filter((path) => !allowedWrites.has(resolve(path)))
      .map((path) => resolve(path)),
  );
  const writePaths = journal.writes.map((write) => resolve(write.path));
  const deletePaths = journal.deletes.map((deletion) => resolve(deletion.path));
  const invalidWrite = journal.writes.some((write) => {
    const path = resolve(write.path);
    if (write.sha256 !== sha256(`${JSON.stringify(write.value, null, 2)}\n`)) {
      return true;
    }
    if (allowedWrites.has(path)) return false;
    const snapshot = write.value as unknown as RecipeRevisionSnapshot;
    const source = plan.sources.find(
      (candidate) => candidate.name === snapshot.source_name,
    );
    const target = plan.targets.find(
      (candidate) => candidate.name === snapshot.lineage_name,
    );
    return (
      snapshot?.type !== "recipe_revision_snapshot" ||
      !source ||
      !target ||
      !["evolve", "replace"].includes(source.action) ||
      snapshot.transition_action !== source.action ||
      !target.sources.includes(source.name) ||
      snapshot.review_id !== plan.reviewId ||
      snapshot.source_sha256 !== source.sha256 ||
      typeof snapshot.content_base64 !== "string" ||
      Buffer.from(snapshot.content_base64, "base64").toString("base64") !==
        snapshot.content_base64 ||
      sha256(Buffer.from(snapshot.content_base64, "base64")) !== source.sha256 ||
      snapshot.rollback_recipe_sha256 !== sha256(canonicalJson(snapshot.rollback_recipe)) ||
      snapshot.target_path !== resolve(target.path) ||
      snapshot.target_sha256 !==
        sha256(`${JSON.stringify(target.recipe, null, 2)}\n`) ||
      path !== resolve(
        RecipesUsage.getRecipeRevisionSnapshotPath(
          target.name,
          snapshot.source_revision,
          recipeRoot,
        ),
      )
    );
  });
  if (
    !["prepared", "committed"].includes(journal.phase) ||
    new Set(writePaths).size !== writePaths.length ||
    new Set(deletePaths).size !== deletePaths.length ||
    invalidWrite ||
    deletePaths.some((path) => !allowedDeletes.has(path)) ||
    writePaths.at(-1) !== resolve(indexPath)
  ) {
    throw new Error("Tool review lineage journal paths do not match the approved plan.");
  }
  for (const path of [...writePaths, ...deletePaths]) {
    assertContainedUsagePath(path, usageRoot);
  }
}

function assertCas(
  current: string | null,
  expected: string | null,
  intended?: string | null,
): void {
  if (current !== expected && current !== intended) {
    throw new Error("Tool review lineage CAS failed.");
  }
}

function rollForward(
  journalPath: string,
  journal: ToolReviewLineageJournal,
  checkpoint?: ToolReviewLineageTransactionOptions["checkpoint"],
): ToolReviewLineageTransactionResult {
  for (const write of journal.writes) {
    assertCas(fileHash(write.path), write.expectedSha256, write.sha256);
    writeJsonAtomic(write.path, write.value);
    checkpoint?.("ledger_written");
  }
  for (const deletion of journal.deletes) {
    assertCas(fileHash(deletion.path), deletion.expectedSha256, null);
    rmSync(deletion.path, { force: true });
  }
  for (const write of journal.writes) {
    if (fileHash(write.path) !== write.sha256) {
      throw new Error(`Tool review lineage write changed: ${write.path}`);
    }
  }
  for (const deletion of journal.deletes) {
    if (existsSync(deletion.path)) {
      throw new Error(`Tool review lineage delete failed: ${deletion.path}`);
    }
  }
  writeJsonAtomic(journalPath, {
    ...journal,
    phase: "committed",
    updatedAt: new Date().toISOString(),
  });
  return { journalPath, phase: "committed" };
}

export function finalizeToolReviewLineage(
  approvedPath: string,
  options: ToolReviewLineageTransactionOptions,
): ToolReviewLineageTransactionResult {
  const plan = JSON.parse(readFileSync(approvedPath, "utf8")) as ToolReviewApprovedPlan;
  const journalPath = `${approvedPath}.lineage-journal.json`;
  const indexPath = RecipesUsage.getRecipeUsageIndexPath(options.recipeRoot);
  return withFileMutationLock(indexPath, () => {
    let journal: ToolReviewLineageJournal;
    if (existsSync(journalPath)) {
      journal = JSON.parse(readFileSync(journalPath, "utf8")) as ToolReviewLineageJournal;
      validateJournal(journal, plan, options.recipeRoot);
      if (journal.phase === "committed") {
        return { journalPath, phase: "committed" };
      }
    } else {
      journal = deriveJournal(
        approvedPath,
        plan,
        options.recipeRoot,
        (options.now ?? (() => new Date()))().toISOString(),
      );
      validateJournal(journal, plan, options.recipeRoot);
      writeJsonAtomic(journalPath, journal);
      options.checkpoint?.("prepared");
    }
    return rollForward(journalPath, journal, options.checkpoint);
  });
}

export interface ToolReviewRevisionRollbackResult {
  journalPath: string;
  lineageName: string;
  restoredRevision: number;
  targetPath: string;
}

interface RecipeRollbackWrite {
  expectedSha256: string;
  path: string;
  sha256: string;
  value: Record<string, unknown>;
}

interface RecipeRollbackJournal {
  lineageName: string;
  operationsSha256: string;
  phase: "committed" | "prepared";
  revision: number;
  snapshotSha256: string;
  updatedAt: string;
  writes: [RecipeRollbackWrite, RecipeRollbackWrite];
}

export interface ToolReviewRevisionRollbackOptions {
  checkpoint?(checkpoint: "ledger_written" | "prepared" | "recipe_written"): void;
  now?(): Date;
  recipeRoot: string;
}

function assertRecipeRollbackPath(path: string, recipeRoot: string): void {
  const relation = relative(resolve(recipeRoot), resolve(path));
  if (!relation || relation === ".." || relation.startsWith("../") || relation.startsWith("..\\")) {
    throw new Error(`Recipe rollback path escapes recipe root: ${path}`);
  }
  let current = resolve(recipeRoot);
  if (!existsSync(current) || lstatSync(current).isSymbolicLink()) {
    throw new Error(`Invalid recipe rollback root: ${current}`);
  }
  for (const segment of relation.split(/[\\/]/u)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in recipe rollback: ${current}`);
    }
  }
}

export function rollbackToolRecipeRevision(
  lineageName: string,
  revision: number,
  options: ToolReviewRevisionRollbackOptions,
): ToolReviewRevisionRollbackResult {
  const snapshotPath = RecipesUsage.getRecipeRevisionSnapshotPath(
    lineageName,
    revision,
    options.recipeRoot,
  );
  const indexPath = RecipesUsage.getRecipeUsageIndexPath(options.recipeRoot);
  const usageRoot = dirname(indexPath);
  const journalPath = `${snapshotPath}.rollback-journal`;
  assertContainedUsagePath(snapshotPath, usageRoot);
  assertContainedUsagePath(journalPath, usageRoot);
  const snapshotBytes = readFileSync(snapshotPath);
  const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as RecipeRevisionSnapshot;
  const encodedSource = typeof snapshot.content_base64 === "string"
    ? Buffer.from(snapshot.content_base64, "base64")
    : undefined;
  if (
    snapshot?.type !== "recipe_revision_snapshot" ||
    snapshot.lineage_name !== lineageName ||
    snapshot.source_revision !== revision ||
    !["evolve", "replace"].includes(snapshot.transition_action) ||
    !snapshot.rollback_recipe ||
    typeof snapshot.rollback_recipe !== "object" ||
    !Object.hasOwn(snapshot.rollback_recipe, "template") ||
    !encodedSource ||
    encodedSource.toString("base64") !== snapshot.content_base64 ||
    sha256(encodedSource) !== snapshot.source_sha256 ||
    snapshot.rollback_recipe_sha256 !== sha256(canonicalJson(snapshot.rollback_recipe)) ||
    RecipesReferences.getRecipeIdFromPath(snapshot.target_path) !== lineageName
  ) {
    throw new Error("Invalid or rotated recipe revision snapshot.");
  }
  assertRecipeRollbackPath(snapshot.target_path, options.recipeRoot);
  const ledgerPath = RecipesUsage.getRecipeUsageLedgerPath(
    lineageName,
    options.recipeRoot,
  );
  assertContainedUsagePath(ledgerPath, usageRoot);
  const snapshotSha256 = sha256(snapshotBytes);
  const result = withFileMutationLock(indexPath, () =>
    withFileMutationLock(snapshot.target_path, () => {
      let journal: RecipeRollbackJournal;
      if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8")) as RecipeRollbackJournal;
      } else {
        const currentTargetSha256 = fileHash(snapshot.target_path);
        const rollbackSha256 = sha256(
          `${JSON.stringify(snapshot.rollback_recipe, null, 2)}\n`,
        );
        if (currentTargetSha256 !== snapshot.target_sha256) {
          throw new Error("Recipe revision rollback target CAS failed.");
        }
        const ledger = RecipesUsage.readRecipeUsage(
          snapshot.target_path,
          options.recipeRoot,
        );
        if (
          !ledger ||
          ledger.lineage_name !== lineageName ||
          fileHash(ledgerPath) === null
        ) {
          throw new Error("Recipe revision rollback lineage is unavailable.");
        }
        const now = (options.now ?? (() => new Date()))().toISOString();
        const fingerprint = recipeFingerprint(snapshot.rollback_recipe);
        const changed = ledger.fingerprint !== fingerprint;
        const nextRevision = (count(ledger.revision) || 1) + (changed ? 1 : 0);
        const events = Array.isArray(ledger.lineage_events)
          ? ledger.lineage_events as Array<Record<string, unknown>>
          : [];
        const revisions = Array.isArray(ledger.revisions)
          ? ledger.revisions as Array<Record<string, unknown>>
          : [];
        const nextLedger = {
          ...ledger,
          fingerprint,
          lineage_events: [
            ...events,
            ...(changed ? [{ at: now, type: "revised" }] : []),
            {
              at: now,
              revision: nextRevision,
              rollback_revision: revision,
              type: "rollback",
            },
          ].slice(-128),
          rollback_of_revision: revision,
          ...(changed
            ? {
                reset_at: now,
                reset_reason: "recipe content fingerprint changed",
                revision: nextRevision,
                revision_calls: 0,
                revision_direct_calls: 0,
                revision_spawn_calls: 0,
                revision_tool_calls: 0,
                revisions: [
                  ...revisions,
                  { fingerprint, first_seen: now, revision: nextRevision },
                ].slice(-128),
              }
            : {}),
        };
        const writes: [RecipeRollbackWrite, RecipeRollbackWrite] = [
          {
            expectedSha256: currentTargetSha256,
            path: snapshot.target_path,
            sha256: rollbackSha256,
            value: snapshot.rollback_recipe,
          },
          {
            expectedSha256: fileHash(ledgerPath)!,
            path: ledgerPath,
            sha256: sha256(`${JSON.stringify(nextLedger, null, 2)}\n`),
            value: nextLedger,
          },
        ];
        journal = {
          lineageName,
          operationsSha256: sha256(canonicalJson(writes)),
          phase: "prepared",
          revision,
          snapshotSha256,
          updatedAt: now,
          writes,
        };
        writeJsonAtomic(journalPath, journal);
        options.checkpoint?.("prepared");
      }
      if (
        journal.lineageName !== lineageName ||
        journal.revision !== revision ||
        journal.snapshotSha256 !== snapshotSha256 ||
        journal.operationsSha256 !== sha256(canonicalJson(journal.writes)) ||
        !["prepared", "committed"].includes(journal.phase) ||
        journal.writes.length !== 2 ||
        resolve(journal.writes[0].path) !== resolve(snapshot.target_path) ||
        resolve(journal.writes[1].path) !== resolve(ledgerPath) ||
        journal.writes.some(
          (write) =>
            write.sha256 !== sha256(`${JSON.stringify(write.value, null, 2)}\n`),
        )
      ) {
        throw new Error("Invalid recipe revision rollback journal.");
      }
      assertContainedUsagePath(journal.writes[1].path, usageRoot);
      for (const write of journal.writes) {
        assertCas(fileHash(write.path), write.expectedSha256, write.sha256);
        writeJsonAtomic(write.path, write.value);
        options.checkpoint?.(
          write.path === snapshot.target_path ? "recipe_written" : "ledger_written",
        );
      }
      if (journal.writes.some((write) => fileHash(write.path) !== write.sha256)) {
        throw new Error("Recipe revision rollback write did not converge.");
      }
      if (journal.phase !== "committed") {
        journal = {
          ...journal,
          phase: "committed",
          updatedAt: new Date().toISOString(),
        };
        writeJsonAtomic(journalPath, journal);
      }
      return journal;
    }),
  );
  return {
    journalPath,
    lineageName,
    restoredRevision: revision,
    targetPath: result.writes[0].path,
  };
}
