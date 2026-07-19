/**
 * Journaled active-tool portfolio mutation.
 * Zones: approved-plan CAS, source quarantine, target commit, crash recovery
 * Owns deterministic filesystem mutation; reviewer policy and runtime activation remain separate domains.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { withFileMutationLock, writeJsonAtomic } from "./file-state.ts";
import * as RecipesReferences from "./recipes-references.ts";
import type { ToolReviewDecision } from "./tool-review.ts";

export interface ToolReviewApprovedSource {
  action: ToolReviewDecision["action"];
  name: string;
  path: string;
  sha256: string;
}

export interface ToolReviewApprovedTarget {
  expectedSha256: string | null;
  lineage: "demote" | "evolve" | "merge" | "replace" | "split";
  name: string;
  path: string;
  recipe: Record<string, unknown>;
  sources: string[];
}

export interface ToolReviewApprovedPlan {
  createdAt: string;
  decisions: ToolReviewDecision[];
  reviewId: string;
  sources: ToolReviewApprovedSource[];
  targets: ToolReviewApprovedTarget[];
}

export type ToolReviewTransactionPhase =
  | "committed"
  | "prepared"
  | "rollback_required"
  | "rolled_back"
  | "sources_quarantined"
  | "targets_written";

interface ToolReviewRootIdentity {
  dev: string;
  ino: string;
  path: string;
  realpath: string;
}

interface ToolReviewTransactionOperations {
  sources: Array<{ original: string; quarantine: string; sha256: string }>;
  targets: Array<{ path: string; sha256: string }>;
}

interface ToolReviewTransactionJournal {
  approvedSha256: string;
  operations: ToolReviewTransactionOperations;
  operationsSha256: string;
  phase: ToolReviewTransactionPhase;
  quarantined: Array<{ original: string; quarantine: string; sha256: string }>;
  reviewId: string;
  roots: {
    cycleDir: ToolReviewRootIdentity;
    quarantineDir: ToolReviewRootIdentity;
    recipeRoot: ToolReviewRootIdentity;
  };
  updatedAt: string;
  writtenTargets: Array<{ path: string; sha256: string }>;
}

export interface ToolReviewTransactionResult {
  evidencePath?: string;
  journalPath: string;
  phase: ToolReviewTransactionPhase;
  quarantineDir: string;
}

export type ToolReviewTransactionCheckpoint =
  | "evidence_written"
  | "prepared"
  | "source_quarantined"
  | "sources_quarantined"
  | "target_written"
  | "targets_written";

export interface ToolReviewTransactionOptions {
  checkpoint?(checkpoint: ToolReviewTransactionCheckpoint): void;
  now?(): Date;
  recipeRoot: string;
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

interface PathContainmentApi {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(...paths: string[]): string;
  sep: string;
}

export function isPathContained(
  path: string,
  root: string,
  pathApi: PathContainmentApi = { isAbsolute, relative, resolve, sep },
): boolean {
  const relation = pathApi.relative(pathApi.resolve(root), pathApi.resolve(path));
  return Boolean(
    relation &&
    relation !== ".." &&
    !relation.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relation),
  );
}

function assertNoSymlinkComponents(path: string, root: string): void {
  const absoluteRoot = resolve(root);
  if (!existsSync(absoluteRoot) || lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error(`Invalid tool review transaction root: ${absoluteRoot}`);
  }
  if (!isPathContained(path, absoluteRoot)) {
    throw new Error(`Tool review path escapes transaction root: ${path}`);
  }
  let current = absoluteRoot;
  for (const segment of relative(absoluteRoot, resolve(path)).split(/[\\/]/u)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in tool review transaction: ${current}`);
    }
  }
}

function captureRootIdentity(path: string): ToolReviewRootIdentity {
  const absolute = resolve(path);
  const lexical = lstatSync(absolute);
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new Error(`Invalid tool review transaction root: ${absolute}`);
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
  cycleDir: string,
  quarantineDir: string,
  recipeRoot: string,
): ToolReviewTransactionJournal["roots"] {
  return {
    cycleDir: captureRootIdentity(cycleDir),
    quarantineDir: captureRootIdentity(quarantineDir),
    recipeRoot: captureRootIdentity(recipeRoot),
  };
}

function verifyRootIdentities(
  roots: ToolReviewTransactionJournal["roots"],
  cycleDir: string,
  quarantineDir: string,
  recipeRoot: string,
): void {
  const current = captureRootIdentities(cycleDir, quarantineDir, recipeRoot);
  for (const key of ["cycleDir", "quarantineDir", "recipeRoot"] as const) {
    const expected = roots?.[key];
    if (
      !expected ||
      expected.path !== current[key].path ||
      expected.realpath !== current[key].realpath ||
      expected.dev !== current[key].dev ||
      expected.ino !== current[key].ino
    ) {
      throw new Error(`Tool review transaction root changed: ${key}`);
    }
  }
}

function deriveOperations(
  plan: ToolReviewApprovedPlan,
  quarantineDir: string,
): ToolReviewTransactionOperations {
  const sources = changedSources(plan).map((source, index) => ({
    original: resolve(source.path),
    quarantine: join(quarantineDir, `${index}-${basename(source.path)}`),
    sha256: source.sha256,
  }));
  const targets = plan.targets.map((target) => ({
    path: resolve(target.path),
    sha256: sha256Bytes(`${JSON.stringify(target.recipe, null, 2)}\n`),
  }));
  return { sources, targets };
}

function assertPlan(plan: ToolReviewApprovedPlan, recipeRoot: string): void {
  if (
    !/^[a-f0-9-]{36}$/u.test(plan.reviewId) ||
    plan.sources.length !== 36 ||
    plan.decisions.length !== 36
  ) {
    throw new Error("Invalid approved tool review plan identity.");
  }
  const sourcePaths = new Set<string>();
  for (const source of plan.sources) {
    if (!isPathContained(source.path, recipeRoot) || sourcePaths.has(resolve(source.path))) {
      throw new Error(`Invalid or duplicate tool review source: ${source.path}`);
    }
    sourcePaths.add(resolve(source.path));
  }
  const targetPaths = new Set<string>();
  for (const target of plan.targets) {
    if (!isPathContained(target.path, recipeRoot) || targetPaths.has(resolve(target.path))) {
      throw new Error(`Invalid or duplicate tool review target: ${target.path}`);
    }
    targetPaths.add(resolve(target.path));
    if (!target.recipe || typeof target.recipe !== "object" || !("template" in target.recipe)) {
      throw new Error(`Incomplete tool review target recipe: ${target.path}`);
    }
  }
}

function readPlan(path: string): ToolReviewApprovedPlan {
  return JSON.parse(readFileSync(path, "utf8")) as ToolReviewApprovedPlan;
}

function readJournal(
  path: string,
  plan: ToolReviewApprovedPlan,
  cycleDir: string,
  quarantineDir: string,
  recipeRoot: string,
): ToolReviewTransactionJournal {
  const journal = JSON.parse(readFileSync(path, "utf8")) as ToolReviewTransactionJournal;
  const phases: ToolReviewTransactionPhase[] = [
    "committed",
    "prepared",
    "rollback_required",
    "rolled_back",
    "sources_quarantined",
    "targets_written",
  ];
  const operations = deriveOperations(plan, quarantineDir);
  if (
    journal.reviewId !== plan.reviewId ||
    journal.approvedSha256 !== sha256Bytes(canonicalJson(plan)) ||
    !phases.includes(journal.phase) ||
    journal.operationsSha256 !== sha256Bytes(canonicalJson(journal.operations)) ||
    canonicalJson(journal.operations) !== canonicalJson(operations) ||
    journal.quarantined.length > operations.sources.length ||
    journal.writtenTargets.length > operations.targets.length ||
    canonicalJson(journal.quarantined) !==
      canonicalJson(operations.sources.slice(0, journal.quarantined.length)) ||
    canonicalJson(journal.writtenTargets) !==
      canonicalJson(operations.targets.slice(0, journal.writtenTargets.length))
  ) {
    throw new Error("Invalid or mismatched tool review transaction journal.");
  }
  verifyRootIdentities(journal.roots, cycleDir, quarantineDir, recipeRoot);
  for (const source of operations.sources) {
    assertNoSymlinkComponents(source.original, recipeRoot);
    assertNoSymlinkComponents(source.quarantine, cycleDir);
  }
  for (const target of operations.targets) {
    assertNoSymlinkComponents(target.path, recipeRoot);
  }
  return journal;
}

function writeJournal(path: string, journal: ToolReviewTransactionJournal): void {
  writeJsonAtomic(path, journal);
}

function changedSources(plan: ToolReviewApprovedPlan): ToolReviewApprovedSource[] {
  return plan.sources.filter((source) => source.action !== "keep");
}

function assertCas(plan: ToolReviewApprovedPlan): void {
  for (const source of plan.sources) {
    if (!existsSync(source.path) || sha256File(source.path) !== source.sha256) {
      throw new Error(`Tool review source CAS failed: ${source.path}`);
    }
  }
  for (const target of plan.targets) {
    if (target.expectedSha256 === null) {
      if (existsSync(target.path)) throw new Error(`Tool review target appeared: ${target.path}`);
    } else if (!existsSync(target.path) || sha256File(target.path) !== target.expectedSha256) {
      throw new Error(`Tool review target CAS failed: ${target.path}`);
    }
  }
}

function rollback(
  journalPath: string,
  journal: ToolReviewTransactionJournal,
  now: Date,
): ToolReviewTransactionJournal {
  for (const target of [...journal.writtenTargets].reverse()) {
    if (!existsSync(target.path)) continue;
    if (sha256File(target.path) !== target.sha256) {
      const failed = { ...journal, phase: "rollback_required" as const, updatedAt: now.toISOString() };
      writeJournal(journalPath, failed);
      return failed;
    }
    rmSync(target.path);
  }
  for (const source of [...journal.quarantined].reverse()) {
    const originalExists = existsSync(source.original);
    const quarantineExists = existsSync(source.quarantine);
    if (
      originalExists &&
      !quarantineExists &&
      sha256File(source.original) === source.sha256
    ) continue;
    if (
      originalExists ||
      !quarantineExists ||
      sha256File(source.quarantine) !== source.sha256
    ) {
      const failed = { ...journal, phase: "rollback_required" as const, updatedAt: now.toISOString() };
      writeJournal(journalPath, failed);
      return failed;
    }
    mkdirSync(dirname(source.original), { recursive: true });
    renameSync(source.quarantine, source.original);
  }
  const rolledBack = {
    ...journal,
    phase: "rolled_back" as const,
    updatedAt: now.toISOString(),
    writtenTargets: [],
  };
  writeJournal(journalPath, rolledBack);
  return rolledBack;
}

function commitEvidence(
  cycleDir: string,
  journalPath: string,
  journal: ToolReviewTransactionJournal,
  plan: ToolReviewApprovedPlan,
  now: Date,
  checkpoint?: ToolReviewTransactionOptions["checkpoint"],
): ToolReviewTransactionResult {
  verifyRootIdentities(
    journal.roots,
    cycleDir,
    join(cycleDir, "quarantine"),
    journal.roots.recipeRoot.path,
  );
  if (journal.writtenTargets.length !== journal.operations.targets.length) {
    throw new Error("Committed tool review targets are incomplete.");
  }
  for (const target of journal.writtenTargets) {
    if (!existsSync(target.path) || sha256File(target.path) !== target.sha256) {
      throw new Error(`Committed tool review target changed: ${target.path}`);
    }
  }
  if (journal.quarantined.length !== journal.operations.sources.length) {
    throw new Error("Committed tool review quarantine is incomplete.");
  }
  for (const source of journal.quarantined) {
    const replacement = journal.operations.targets.find(
      (target) => resolve(target.path) === resolve(source.original),
    );
    if (
      existsSync(source.original) &&
      (!replacement || sha256File(source.original) !== replacement.sha256)
    ) {
      throw new Error(`Committed tool review source changed: ${source.original}`);
    }
    if (
      !existsSync(source.quarantine) ||
      sha256File(source.quarantine) !== source.sha256
    ) {
      throw new Error(`Committed tool review quarantine changed: ${source.quarantine}`);
    }
  }
  const evidencePath = join(cycleDir, "evidence.json");
  writeJsonAtomic(evidencePath, {
    actions: Object.fromEntries(
      [...new Set(plan.sources.map((source) => source.action))].map((action) => [
        action,
        plan.sources.filter((source) => source.action === action).length,
      ])),
    reviewId: plan.reviewId,
    sources: plan.sources.length,
    targets: plan.targets.length,
    ts: now.toISOString(),
  });
  checkpoint?.("evidence_written");
  const committed = { ...journal, phase: "committed" as const, updatedAt: now.toISOString() };
  writeJournal(journalPath, committed);
  return {
    evidencePath,
    journalPath,
    phase: "committed",
    quarantineDir: join(cycleDir, "quarantine"),
  };
}

export function applyToolReviewPlan(
  approvedPath: string,
  options: ToolReviewTransactionOptions,
): ToolReviewTransactionResult {
  const plan = readPlan(approvedPath);
  assertPlan(plan, options.recipeRoot);
  const cycleDir = dirname(approvedPath);
  const journalPath = join(cycleDir, "journal.json");
  const quarantineDir = join(cycleDir, "quarantine");
  const now = options.now ?? (() => new Date());
  return withFileMutationLock(options.recipeRoot, () => {
    if (existsSync(journalPath)) {
      throw new Error(`Tool review transaction already exists: ${plan.reviewId}`);
    }
    mkdirSync(quarantineDir, { recursive: true });
    const operations = deriveOperations(plan, quarantineDir);
    const roots = captureRootIdentities(
      cycleDir,
      quarantineDir,
      options.recipeRoot,
    );
    for (const source of operations.sources) {
      assertNoSymlinkComponents(source.original, options.recipeRoot);
      assertNoSymlinkComponents(source.quarantine, cycleDir);
    }
    for (const target of operations.targets) {
      assertNoSymlinkComponents(target.path, options.recipeRoot);
    }
    assertCas(plan);
    let journal: ToolReviewTransactionJournal = {
      approvedSha256: sha256Bytes(canonicalJson(plan)),
      operations,
      operationsSha256: sha256Bytes(canonicalJson(operations)),
      phase: "prepared",
      quarantined: [],
      reviewId: plan.reviewId,
      roots,
      updatedAt: now().toISOString(),
      writtenTargets: [],
    };
    writeJournal(journalPath, journal);
    options.checkpoint?.("prepared");
    try {
      for (const source of operations.sources) {
        journal = {
          ...journal,
          quarantined: [...journal.quarantined, source],
          updatedAt: now().toISOString(),
        };
        writeJournal(journalPath, journal);
        renameSync(source.original, source.quarantine);
        options.checkpoint?.("source_quarantined");
      }
      journal = { ...journal, phase: "sources_quarantined", updatedAt: now().toISOString() };
      writeJournal(journalPath, journal);
      options.checkpoint?.("sources_quarantined");
      for (const [index, target] of plan.targets.entries()) {
        const operation = operations.targets[index]!;
        mkdirSync(dirname(operation.path), { recursive: true });
        journal = {
          ...journal,
          writtenTargets: [...journal.writtenTargets, operation],
          updatedAt: now().toISOString(),
        };
        writeJournal(journalPath, journal);
        writeJsonAtomic(operation.path, target.recipe);
        if (
          sha256File(operation.path) !== operation.sha256 ||
          !RecipesReferences.readResolvedRecipeConfig(operation.path)
        ) {
          throw new Error(`Written tool review target is invalid: ${operation.path}`);
        }
        options.checkpoint?.("target_written");
      }
      journal = { ...journal, phase: "targets_written", updatedAt: now().toISOString() };
      writeJournal(journalPath, journal);
      options.checkpoint?.("targets_written");
      return commitEvidence(
        cycleDir,
        journalPath,
        journal,
        plan,
        now(),
        options.checkpoint,
      );
    } catch (error) {
      const result = rollback(journalPath, journal, now());
      if (result.phase === "rollback_required") {
        throw new Error(`Tool review rollback requires operator attention: ${plan.reviewId}`);
      }
      throw error;
    }
  });
}

export function recoverToolReviewTransaction(
  approvedPath: string,
  options: ToolReviewTransactionOptions,
): ToolReviewTransactionResult {
  const plan = readPlan(approvedPath);
  assertPlan(plan, options.recipeRoot);
  const cycleDir = dirname(approvedPath);
  const journalPath = join(cycleDir, "journal.json");
  const quarantineDir = join(cycleDir, "quarantine");
  const now = options.now ?? (() => new Date());
  return withFileMutationLock(options.recipeRoot, () => {
    const journal = readJournal(
      journalPath,
      plan,
      cycleDir,
      quarantineDir,
      options.recipeRoot,
    );
    if (journal.phase === "committed") {
      return commitEvidence(cycleDir, journalPath, journal, plan, now());
    }
    if (journal.phase === "targets_written") {
      return commitEvidence(cycleDir, journalPath, journal, plan, now());
    }
    if (journal.phase === "rollback_required") {
      return { journalPath, phase: journal.phase, quarantineDir };
    }
    const recovered = rollback(journalPath, journal, now());
    return { journalPath, phase: recovered.phase, quarantineDir };
  });
}
