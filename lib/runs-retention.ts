/**
 * Async run retention operations.
 * Owns terminal-run archive and prune filesystem behavior.
 */

import { cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeJsonAtomic } from "./file-state.ts";
import {
  resolveArtifactManifest,
  type RunArtifactDeclaration,
} from "./runs-artifacts.ts";
import { safeRunId } from "./runs-identity.ts";

function archivePathFor(run: string, stateDir: string): string {
  const archiveRoot = join(dirname(stateDir), "archived");
  mkdirSync(archiveRoot, { recursive: true });
  return join(
    archiveRoot,
    `${safeRunId(run)}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
}

export function archiveTerminalRun(
  status: Record<string, unknown>,
): Record<string, unknown> {
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  const archiveDir = archivePathFor(run, stateDir);
  renameSync(stateDir, archiveDir);
  mkdirSync(stateDir, { recursive: true });
  const tombstone = {
    archived: true,
    archive_dir: archiveDir,
    original_state_dir: stateDir,
    run,
    status: status.status,
    ts: new Date().toISOString(),
  };
  writeJsonAtomic(join(stateDir, "archive-tombstone.json"), tombstone);
  return tombstone;
}

export function pruneTerminalRun(
  status: Record<string, unknown>,
  options: { preserveArtifacts?: boolean } = {},
): Record<string, unknown> {
  const stateDir = String(status.state_dir);
  const run = String(status.run ?? basename(stateDir));
  const manifest = resolveArtifactManifest(
    status.artifacts as Record<string, RunArtifactDeclaration> | undefined,
  );
  const preserved: Record<string, string> = {};
  if (options.preserveArtifacts && manifest) {
    const preserveRoot = join(
      dirname(stateDir),
      "preserved-artifacts",
      safeRunId(run),
    );
    mkdirSync(preserveRoot, { recursive: true });
    for (const [name, artifact] of Object.entries(manifest)) {
      if (!artifact.exists) continue;
      const target = join(preserveRoot, basename(artifact.path));
      cpSync(artifact.path, target, { force: true });
      preserved[name] = target;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  return {
    pruned: true,
    preserved_artifacts: preserved,
    run,
    state_dir: stateDir,
    ts: new Date().toISOString(),
  };
}
