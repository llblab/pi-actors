/**
 * Deterministic draft consolidation transaction and crash recovery.
 * Owns: cycle claim, source/target compare-and-swap, complete recipe persistence, source quarantine, journal transitions, rollback, and runtime evidence.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import type {
  DraftConsolidationPlan,
  DraftConsolidationPlanItem,
} from "./draft-consolidation.ts";
import {
  validateDraftConsolidationPlan,
  type DraftConsolidationInventoryItem,
} from "./draft-consolidation.ts";
import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as RecipesReferences from "./recipes-references.ts";

export type DraftConsolidationTransactionPhase =
  | "prepared"
  | "targets_validated"
  | "sources_quarantined"
  | "committed_evidence_pending"
  | "committed"
  | "rolled_back"
  | "rollback_required";

interface TargetOperation {
  backupPath?: string;
  expectedSha256: string | null;
  intendedSha256: string;
  path: string;
  recipe: Record<string, unknown>;
  target: string;
}

interface SourceOperation {
  path: string;
  quarantinePath: string;
  sha256: string;
}

interface ConsolidationRootIdentity {
  dev: string;
  ino: string;
  path: string;
  realpath: string;
}

interface ConsolidationRootIdentities {
  cycleDir: ConsolidationRootIdentity;
  draftRoot: ConsolidationRootIdentity;
  recipeRoot: ConsolidationRootIdentity;
}

export interface DraftConsolidationJournal {
  cycleId: string;
  error?: string;
  operationsSha256: string;
  phase: DraftConsolidationTransactionPhase;
  plan: DraftConsolidationPlan;
  planSha256: string;
  roots: ConsolidationRootIdentities;
  sourceScope: "batch" | "complete";
  sources: SourceOperation[];
  targets: TargetOperation[];
  updatedAt: string;
}

export type DraftConsolidationCheckpoint =
  | "prepared"
  | "target_written"
  | "targets_validated"
  | "source_quarantined"
  | "sources_quarantined"
  | "committed_evidence_pending"
  | "evidence_written";

export interface DraftConsolidationTransactionOptions {
  checkpoint?(point: DraftConsolidationCheckpoint): void;
  cycleDir: string;
  draftRoot: string;
  inventory: DraftConsolidationInventoryItem[];
  onLockContention?(): void;
  sourceScope?: "batch" | "complete";
  recipeRoot: string;
}

export interface DraftConsolidationTransactionResult {
  cycleId: string;
  evidencePath: string;
  phase: "committed" | "rolled_back";
  plan: DraftConsolidationPlan;
  sources: number;
  targets: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recipeBytes(recipe: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`, "utf8");
}

function writeBytesAtomic(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function assertContainedRegularFile(path: string, root: string): void {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  const relation = relative(canonicalRoot, canonicalPath);
  if (!relation || relation.startsWith("..") || resolve(relation) === relation) {
    throw new Error(`Path escapes consolidation root: ${path}`);
  }
  const stat = lstatSync(canonicalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Consolidation source must be a regular non-symlink file: ${path}`);
  }
}

function isContainedPath(path: string, root: string): boolean {
  const relation = relative(resolve(root), resolve(path));
  return Boolean(relation) && !relation.startsWith("..") && resolve(relation) !== relation;
}

function assertNoSymlinkComponents(path: string, root: string): void {
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new Error(`Symlink is not allowed in consolidation state: ${root}`);
  }
  if (!isContainedPath(path, root)) {
    throw new Error(`Path escapes consolidation root: ${path}`);
  }
  let current = resolve(root);
  for (const segment of relative(current, resolve(path)).split(/[\\/]/u)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in consolidation state: ${current}`);
    }
  }
}

function captureRootIdentity(path: string): ConsolidationRootIdentity {
  const absolute = resolve(path);
  const lexical = lstatSync(absolute);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new Error(`Symlink is not allowed in consolidation state: ${absolute}`);
  }
  const canonical = realpathSync.native(absolute);
  const stat = statSync(canonical, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    path: absolute,
    realpath: canonical,
  };
}

function captureRootIdentities(
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "draftRoot" | "recipeRoot"
  >,
): ConsolidationRootIdentities {
  return {
    cycleDir: captureRootIdentity(options.cycleDir),
    draftRoot: captureRootIdentity(options.draftRoot),
    recipeRoot: captureRootIdentity(options.recipeRoot),
  };
}

function verifyRootIdentities(
  recorded: ConsolidationRootIdentities,
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "draftRoot" | "recipeRoot"
  >,
): void {
  if (!recorded || typeof recorded !== "object") {
    throw new Error("Consolidation root identity is missing.");
  }
  const current = captureRootIdentities(options);
  for (const key of ["cycleDir", "draftRoot", "recipeRoot"] as const) {
    const expected = recorded[key];
    if (
      !expected ||
      expected.path !== current[key].path ||
      expected.realpath !== current[key].realpath ||
      expected.dev !== current[key].dev ||
      expected.ino !== current[key].ino
    ) {
      throw new Error(`Consolidation root identity changed: ${key}`);
    }
  }
}

function readValidatedJournal(
  path: string,
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "draftRoot" | "recipeRoot"
  >,
): DraftConsolidationJournal {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid consolidation journal object.");
  }
  const journal = value as DraftConsolidationJournal;
  const phases: DraftConsolidationTransactionPhase[] = [
    "prepared",
    "targets_validated",
    "sources_quarantined",
    "committed_evidence_pending",
    "committed",
    "rolled_back",
    "rollback_required",
  ];
  if (
    !phases.includes(journal.phase) ||
    journal.cycleId !== basename(resolve(options.cycleDir)) ||
    !journal.plan ||
    journal.plan.cycleId !== journal.cycleId ||
    journal.planSha256 !== sha256(canonicalJson(journal.plan)) ||
    !["batch", "complete"].includes(journal.sourceScope) ||
    !Array.isArray(journal.sources) ||
    !Array.isArray(journal.targets)
  ) {
    throw new Error("Invalid or mismatched consolidation journal identity.");
  }
  verifyRootIdentities(journal.roots, options);
  const derived = deriveOperations(journal.plan, options);
  const operationIdentity = {
    roots: journal.roots,
    sourceScope: journal.sourceScope,
    sources: journal.sources,
    targets: journal.targets,
  };
  if (
    journal.operationsSha256 !== sha256(canonicalJson(operationIdentity)) ||
    canonicalJson({ sources: journal.sources, targets: journal.targets }) !==
      canonicalJson(derived)
  ) {
    throw new Error("Consolidation journal operations do not match its plan.");
  }
  const sourcePaths = new Set<string>();
  for (const source of journal.sources) {
    if (
      !source ||
      typeof source.path !== "string" ||
      typeof source.quarantinePath !== "string" ||
      typeof source.sha256 !== "string" ||
      !isContainedPath(source.path, options.draftRoot) ||
      !isContainedPath(
        source.quarantinePath,
        join(options.cycleDir, "quarantine"),
      ) ||
      sourcePaths.has(resolve(source.path))
    ) {
      throw new Error("Invalid consolidation journal source path.");
    }
    assertNoSymlinkComponents(source.path, options.draftRoot);
    assertNoSymlinkComponents(source.quarantinePath, options.cycleDir);
    sourcePaths.add(resolve(source.path));
  }
  const targetPaths = new Set<string>();
  for (const target of journal.targets) {
    const expectedPath =
      target && typeof target.target === "string"
        ? join(options.recipeRoot, `${target.target}.json`)
        : "";
    if (
      !target ||
      typeof target.path !== "string" ||
      typeof target.intendedSha256 !== "string" ||
      resolve(target.path) !== resolve(expectedPath) ||
      !isContainedPath(target.path, options.recipeRoot) ||
      (target.backupPath !== undefined &&
        (typeof target.backupPath !== "string" ||
          !isContainedPath(target.backupPath, join(options.cycleDir, "backups")))) ||
      targetPaths.has(resolve(target.path))
    ) {
      throw new Error("Invalid consolidation journal target path.");
    }
    assertNoSymlinkComponents(target.path, options.recipeRoot);
    if (target.backupPath) {
      assertNoSymlinkComponents(target.backupPath, options.cycleDir);
    }
    targetPaths.add(resolve(target.path));
  }
  return journal;
}

function listDraftFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && [".json", ".md"].includes(extname(entry.name))) {
        files.push(resolve(path));
      }
    }
  };
  visit(root);
  return files.sort();
}

function uniqueTargetItems(
  plan: DraftConsolidationPlan,
): DraftConsolidationPlanItem[] {
  const targets = new Map<string, DraftConsolidationPlanItem>();
  for (const item of plan.drafts) {
    if (item.action === "discard" || !item.target) continue;
    if (!targets.has(item.target)) targets.set(item.target, item);
  }
  return [...targets.values()].sort((left, right) =>
    String(left.target).localeCompare(String(right.target)),
  );
}

function deriveOperations(
  plan: DraftConsolidationPlan,
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "recipeRoot"
  >,
): { sources: SourceOperation[]; targets: TargetOperation[] } {
  const quarantineDir = join(options.cycleDir, "quarantine");
  const backupDir = join(options.cycleDir, "backups");
  const sources = plan.drafts.map((item, index) => ({
    path: resolve(item.draft),
    quarantinePath: join(
      quarantineDir,
      `${String(index + 1).padStart(4, "0")}-${basename(item.draft)}`,
    ),
    sha256: item.sha256,
  }));
  const targets = uniqueTargetItems(plan).map((item) => ({
    ...(item.targetSha256 !== null
      ? { backupPath: join(backupDir, `${item.target}.json`) }
      : {}),
    expectedSha256: item.targetSha256 ?? null,
    intendedSha256: sha256(recipeBytes(item.recipe!)),
    path: join(options.recipeRoot, `${item.target}.json`),
    recipe: item.recipe!,
    target: item.target!,
  }));
  return { sources, targets };
}

function createJournal(
  plan: DraftConsolidationPlan,
  options: DraftConsolidationTransactionOptions,
): DraftConsolidationJournal {
  const operations = deriveOperations(plan, options);
  const roots = captureRootIdentities(options);
  const sourceScope = options.sourceScope ?? "complete";
  for (const target of operations.targets) {
    if (target.backupPath && existsSync(target.path)) {
      writeBytesAtomic(target.backupPath, readFileSync(target.path));
    }
  }
  return {
    cycleId: plan.cycleId,
    operationsSha256: sha256(canonicalJson({ roots, sourceScope, ...operations })),
    phase: "prepared",
    plan,
    planSha256: sha256(canonicalJson(plan)),
    roots,
    sourceScope,
    ...operations,
    updatedAt: new Date().toISOString(),
  };
}

function persistJournal(path: string, journal: DraftConsolidationJournal): void {
  journal.updatedAt = new Date().toISOString();
  writeJsonAtomic(path, journal);
}

function verifyPreconditions(
  journal: DraftConsolidationJournal,
  options: DraftConsolidationTransactionOptions,
): void {
  const plannedSources = journal.sources.map((source) => source.path).sort();
  const currentSources = listDraftFiles(options.draftRoot);
  if (
    journal.sourceScope === "complete" &&
    JSON.stringify(plannedSources) !== JSON.stringify(currentSources)
  ) {
    throw new Error("Draft inventory changed after planning.");
  }
  for (const source of journal.sources) {
    assertContainedRegularFile(source.path, options.draftRoot);
    if (sha256(readFileSync(source.path)) !== source.sha256) {
      throw new Error(`Draft source changed: ${source.path}`);
    }
  }
  for (const target of journal.targets) {
    if (target.expectedSha256 === null) {
      if (existsSync(target.path)) {
        throw new Error(`Active target appeared after planning: ${target.target}`);
      }
      continue;
    }
    assertContainedRegularFile(target.path, options.recipeRoot);
    if (sha256(readFileSync(target.path)) !== target.expectedSha256) {
      throw new Error(`Active target changed after planning: ${target.target}`);
    }
  }
}

function writeEvidence(
  path: string,
  journal: DraftConsolidationJournal,
  outcome: "committed" | "rolled_back",
): void {
  writeJsonAtomic(path, {
    cycleId: journal.cycleId,
    outcome,
    phase: journal.phase,
    decisions: journal.plan.drafts.map((item) => ({
      action: item.action,
      draft: item.draft,
      rationale: item.rationale,
      sha256: item.sha256,
      ...(item.target ? { target: item.target } : {}),
      ...(item.targetSha256 !== undefined
        ? { targetSha256: item.targetSha256 }
        : {}),
    })),
    ...(journal.error ? { error: journal.error } : {}),
    sources: journal.sources.map((source) => ({
      path: source.path,
      quarantinePath: source.quarantinePath,
    })),
    targets: journal.targets.map((target) => ({
      path: target.path,
      target: target.target,
    })),
    ts: new Date().toISOString(),
  });
}

function restoreJournal(
  journal: DraftConsolidationJournal,
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "draftRoot" | "recipeRoot"
  >,
): string[] {
  const errors: string[] = [];
  for (const source of [...journal.sources].reverse()) {
    try {
      if (existsSync(source.path)) {
        assertContainedRegularFile(source.path, options.draftRoot);
      } else {
        assertNoSymlinkComponents(source.path, options.draftRoot);
      }
      assertNoSymlinkComponents(source.quarantinePath, options.cycleDir);
      if (existsSync(source.quarantinePath)) {
        assertContainedRegularFile(source.quarantinePath, options.cycleDir);
      }
      const originalHash = existsSync(source.path)
        ? sha256(readFileSync(source.path))
        : undefined;
      const quarantineHash = existsSync(source.quarantinePath)
        ? sha256(readFileSync(source.quarantinePath))
        : undefined;
      if (originalHash !== undefined && originalHash !== source.sha256) {
        throw new Error("original source changed after crash");
      }
      if (quarantineHash !== undefined && quarantineHash !== source.sha256) {
        throw new Error("quarantined source changed after crash");
      }
      if (originalHash === undefined && quarantineHash === source.sha256) {
        mkdirSync(dirname(source.path), { recursive: true });
        renameSync(source.quarantinePath, source.path);
      } else if (originalHash === undefined && quarantineHash === undefined) {
        throw new Error("source and quarantine are both missing");
      }
    } catch (error) {
      errors.push(`source ${source.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const target of [...journal.targets].reverse()) {
    try {
      assertNoSymlinkComponents(target.path, options.recipeRoot);
      if (existsSync(target.path)) {
        assertContainedRegularFile(target.path, options.recipeRoot);
      }
      if (target.backupPath) {
        assertNoSymlinkComponents(target.backupPath, options.cycleDir);
        if (existsSync(target.backupPath)) {
          assertContainedRegularFile(target.backupPath, options.cycleDir);
        }
      }
      const currentHash = existsSync(target.path)
        ? sha256(readFileSync(target.path))
        : undefined;
      if (
        (target.expectedSha256 === null && currentHash === undefined) ||
        currentHash === target.expectedSha256
      ) {
        continue;
      }
      if (currentHash !== target.intendedSha256) {
        throw new Error("target changed after crash");
      }
      if (target.expectedSha256 === null) {
        rmSync(target.path, { force: true });
        continue;
      }
      if (!target.backupPath || !existsSync(target.backupPath)) {
        throw new Error("target backup is missing");
      }
      const backup = readFileSync(target.backupPath);
      if (sha256(backup) !== target.expectedSha256) {
        throw new Error("target backup changed after crash");
      }
      writeBytesAtomic(target.path, backup);
    } catch (error) {
      errors.push(`target ${target.target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function verifyCommitState(
  journal: DraftConsolidationJournal,
  options: Pick<
    DraftConsolidationTransactionOptions,
    "cycleDir" | "draftRoot" | "recipeRoot"
  >,
): void {
  for (const source of journal.sources) {
    if (existsSync(source.path)) {
      throw new Error(`Committed source still exists: ${source.path}`);
    }
    if (!existsSync(source.quarantinePath)) {
      throw new Error(`Committed quarantine is missing: ${source.quarantinePath}`);
    }
    assertContainedRegularFile(
      source.quarantinePath,
      join(options.cycleDir, "quarantine"),
    );
    if (sha256(readFileSync(source.quarantinePath)) !== source.sha256) {
      throw new Error(`Committed quarantine changed: ${source.quarantinePath}`);
    }
  }
  for (const target of journal.targets) {
    if (!existsSync(target.path)) {
      throw new Error(`Committed target is missing: ${target.target}`);
    }
    assertContainedRegularFile(target.path, options.recipeRoot);
    if (sha256(readFileSync(target.path)) !== target.intendedSha256) {
      throw new Error(`Committed target changed: ${target.target}`);
    }
    if (!RecipesReferences.readResolvedRecipeConfig(target.path)) {
      throw new Error(`Committed target is invalid: ${target.target}`);
    }
  }
  if (
    journal.sourceScope === "complete" &&
    listDraftFiles(options.draftRoot).length !== 0
  ) {
    throw new Error("Draft directory changed during consolidation.");
  }
}

function verifyRollbackState(
  journal: DraftConsolidationJournal,
  options: Pick<DraftConsolidationTransactionOptions, "draftRoot" | "recipeRoot">,
): void {
  for (const source of journal.sources) {
    if (existsSync(source.path)) {
      assertContainedRegularFile(source.path, options.draftRoot);
    }
    if (!existsSync(source.path) || sha256(readFileSync(source.path)) !== source.sha256) {
      throw new Error(`Rolled-back source is missing or changed: ${source.path}`);
    }
  }
  for (const target of journal.targets) {
    assertNoSymlinkComponents(target.path, options.recipeRoot);
    if (existsSync(target.path)) {
      assertContainedRegularFile(target.path, options.recipeRoot);
    }
    const currentHash = existsSync(target.path)
      ? sha256(readFileSync(target.path))
      : undefined;
    if (
      (target.expectedSha256 === null && currentHash !== undefined) ||
      (target.expectedSha256 !== null && currentHash !== target.expectedSha256)
    ) {
      throw new Error(`Rolled-back target is missing or changed: ${target.target}`);
    }
  }
}

function withMutationLocks<T>(
  paths: string[],
  mutate: () => T,
  onContention?: () => void,
): T {
  const ordered = [...new Set(paths.map((path) => resolve(path)))].sort();
  const acquire = (index: number): T =>
    index >= ordered.length
      ? mutate()
      : withFileMutationLock(
          ordered[index]!,
          () => acquire(index + 1),
          { onContention },
        );
  return acquire(0);
}

export function applyDraftConsolidationPlan(
  plan: DraftConsolidationPlan,
  options: DraftConsolidationTransactionOptions,
): DraftConsolidationTransactionResult {
  const validation = validateDraftConsolidationPlan(options.inventory, plan);
  if (!validation.ok) {
    throw new Error(`Invalid consolidation plan: ${validation.errors.join("; ")}`);
  }
  const journalPath = join(options.cycleDir, "journal.json");
  const evidencePath = join(options.cycleDir, "evidence.json");
  const lockPaths = [
    options.draftRoot,
    ...plan.drafts.map((item) => item.draft),
    ...uniqueTargetItems(plan).map((item) =>
      join(options.recipeRoot, `${item.target}.json`),
    ),
  ];
  return withMutationLocks(lockPaths, () => {
    if (existsSync(journalPath)) {
      throw new Error(`Consolidation cycle already claimed: ${plan.cycleId}`);
    }
    mkdirSync(options.cycleDir, { recursive: true });
    const journal = createJournal(plan, options);
    persistJournal(journalPath, journal);
    options.checkpoint?.("prepared");
    let mutationStarted = false;
    try {
      verifyPreconditions(journal, options);
      for (const target of journal.targets) {
        mutationStarted = true;
        writeJsonAtomic(target.path, target.recipe);
        options.checkpoint?.("target_written");
        if (!RecipesReferences.readResolvedRecipeConfig(target.path)) {
          throw new Error(`Persisted target recipe is invalid: ${target.target}`);
        }
      }
      journal.phase = "targets_validated";
      persistJournal(journalPath, journal);
      options.checkpoint?.("targets_validated");
      for (const source of journal.sources) {
        if (sha256(readFileSync(source.path)) !== source.sha256) {
          throw new Error(`Draft source changed before quarantine: ${source.path}`);
        }
        mkdirSync(dirname(source.quarantinePath), { recursive: true });
        renameSync(source.path, source.quarantinePath);
        options.checkpoint?.("source_quarantined");
      }
      journal.phase = "sources_quarantined";
      persistJournal(journalPath, journal);
      options.checkpoint?.("sources_quarantined");
      verifyCommitState(journal, options);
      journal.phase = "committed_evidence_pending";
      persistJournal(journalPath, journal);
      options.checkpoint?.("committed_evidence_pending");
      writeEvidence(evidencePath, journal, "committed");
      options.checkpoint?.("evidence_written");
      journal.phase = "committed";
      persistJournal(journalPath, journal);
      return {
        cycleId: plan.cycleId,
        evidencePath,
        phase: "committed",
        plan: journal.plan,
        sources: journal.sources.length,
        targets: journal.targets.length,
      };
    } catch (error) {
      journal.error = error instanceof Error ? error.message : String(error);
      const rollbackErrors = mutationStarted ? restoreJournal(journal, options) : [];
      journal.phase = rollbackErrors.length > 0 ? "rollback_required" : "rolled_back";
      if (rollbackErrors.length > 0) {
        journal.error = `${journal.error}; rollback: ${rollbackErrors.join("; ")}`;
      }
      persistJournal(journalPath, journal);
      if (journal.phase === "rolled_back") {
        writeEvidence(evidencePath, journal, "rolled_back");
      }
      throw error;
    }
  }, options.onLockContention);
}

export function recoverDraftConsolidationCycle(
  options: Pick<DraftConsolidationTransactionOptions, "cycleDir" | "draftRoot" | "recipeRoot">,
): DraftConsolidationTransactionResult {
  const journalPath = join(options.cycleDir, "journal.json");
  const evidencePath = join(options.cycleDir, "evidence.json");
  const observed = readValidatedJournal(journalPath, options);
  const lockPaths = [
    options.draftRoot,
    ...observed.sources.map((source) => source.path),
    ...observed.targets.map((target) => target.path),
  ];
  return withMutationLocks(lockPaths, () => {
    const journal = readValidatedJournal(journalPath, options);
    if (journal.phase === "committed") {
      verifyCommitState(journal, options);
      writeEvidence(evidencePath, journal, "committed");
      return {
        cycleId: journal.cycleId,
        evidencePath,
        phase: "committed",
        plan: journal.plan,
        sources: journal.sources.length,
        targets: journal.targets.length,
      };
    }
    if (journal.phase === "rolled_back") {
      verifyRollbackState(journal, options);
      writeEvidence(evidencePath, journal, "rolled_back");
      return {
        cycleId: journal.cycleId,
        evidencePath,
        phase: "rolled_back",
        plan: journal.plan,
        sources: journal.sources.length,
        targets: journal.targets.length,
      };
    }
    if (
      journal.phase === "sources_quarantined" ||
      journal.phase === "committed_evidence_pending"
    ) {
      verifyCommitState(journal, options);
      journal.phase = "committed_evidence_pending";
      persistJournal(journalPath, journal);
      writeEvidence(evidencePath, journal, "committed");
      journal.phase = "committed";
      persistJournal(journalPath, journal);
      return {
        cycleId: journal.cycleId,
        evidencePath,
        phase: "committed",
        plan: journal.plan,
        sources: journal.sources.length,
        targets: journal.targets.length,
      };
    }
    const rollbackErrors = restoreJournal(journal, options);
    if (rollbackErrors.length === 0) {
      try {
        verifyRollbackState(journal, options);
      } catch (error) {
        rollbackErrors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    journal.phase = rollbackErrors.length > 0 ? "rollback_required" : "rolled_back";
    if (rollbackErrors.length > 0) {
      journal.error = `rollback: ${rollbackErrors.join("; ")}`;
    }
    persistJournal(journalPath, journal);
    if (journal.phase === "rollback_required") {
      throw new Error(journal.error);
    }
    writeEvidence(evidencePath, journal, "rolled_back");
    return {
      cycleId: journal.cycleId,
      evidencePath,
      phase: "rolled_back",
      plan: journal.plan,
      sources: journal.sources.length,
      targets: journal.targets.length,
    };
  });
}
