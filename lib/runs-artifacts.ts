/**
 * Async run artifact declarations and manifest resolution.
 * Owns: artifact path expansion, captured-reference validation, body-free metadata observation and explicit hashing.
 * Excludes: generation admission, export publication, directory scans and production/immutable-content proof.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute, sep } from "node:path";

import { substituteCommandTemplateToken } from "./command-templates.ts";

export type RunArtifactDeclaration =
  | string
  | { path: string; kind?: string; media_type?: string; required?: boolean };

export interface RunArtifactManifestEntry {
  exists: boolean;
  kind?: string;
  media_type?: string;
  path: string;
  required?: boolean;
  sha256?: string;
  size?: number;
}

export interface RunArtifactReference {
  readonly name: string;
  readonly path: string;
  readonly kind?: string;
  readonly media_type?: string;
  readonly required?: boolean;
}
export type RunArtifactReferencesReading = { readonly state: "available"; readonly references: readonly Readonly<RunArtifactReference>[] }
  | { readonly state: "unavailable"; readonly reason: "artifact_declarations_invalid" | "artifact_base_unavailable" };
export type RunArtifactObservation = Readonly<RunArtifactReference & {
  availability: "available" | "missing" | "unavailable";
  bytes_total?: number;
  modified_at?: string;
  reason?: "artifact_not_regular" | "artifact_changed" | "artifact_unreadable" | "artifact_size_unavailable";
}>;

/** Captured paths only: no placeholder/environment expansion, directory discovery or fallback to this process's cwd. */
export function describeRunArtifactReferences(artifacts: unknown, cwd: unknown): RunArtifactReferencesReading {
  if (artifacts === undefined) return Object.freeze({ state: "available", references: Object.freeze([]) });
  const invalid = (): RunArtifactReferencesReading => Object.freeze({ state: "unavailable", reason: "artifact_declarations_invalid" });
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return invalid();
  const references: Readonly<RunArtifactReference>[] = [];
  for (const [name, value] of Object.entries(artifacts)) {
    if (!name.trim() || /[\u0000-\u001f\u007f]/u.test(name)) return invalid();
    const declaration = typeof value === "string" ? { path: value } : value;
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return invalid();
    const item = declaration as Record<string, unknown>;
    if (Object.keys(item).some(key => !["path", "kind", "media_type", "required"].includes(key)) || !Object.hasOwn(item, "path") ||
      typeof item.path !== "string" || !item.path || /[\u0000-\u001f\u007f]/u.test(item.path) ||
      (item.kind !== undefined && typeof item.kind !== "string") || (item.media_type !== undefined && typeof item.media_type !== "string") ||
      (item.required !== undefined && typeof item.required !== "boolean")) return invalid();
    if (!isAbsolute(item.path) && (typeof cwd !== "string" || !isAbsolute(cwd) || /[\u0000-\u001f\u007f]/u.test(cwd))) {
      return Object.freeze({ state: "unavailable", reason: "artifact_base_unavailable" });
    }
    // Lexical normalization can retarget symlink/.. references; anchor cwd without rewriting the declared path.
    const path = isAbsolute(item.path) ? item.path : `${cwd}${(cwd as string).endsWith(sep) ? "" : sep}${item.path}`;
    references.push(Object.freeze({ name, path,
      ...(typeof item.kind === "string" ? { kind: item.kind } : {}),
      ...(typeof item.media_type === "string" ? { media_type: item.media_type } : {}),
      ...(typeof item.required === "boolean" ? { required: item.required } : {}) }));
  }
  return Object.freeze({ state: "available", references: Object.freeze(references) });
}

/** Readability/stat evidence only. A declared file need not have been created by this Run and is never hashed here. */
export function observeRunArtifactReference(reference: Readonly<RunArtifactReference>): RunArtifactObservation {
  const unavailable = (reason: NonNullable<RunArtifactObservation["reason"]>): RunArtifactObservation =>
    Object.freeze({ ...reference, availability: "unavailable", reason });
  let observed = false;
  try {
    const before = lstatSync(reference.path, { bigint: true });
    observed = true;
    if (!before.isFile()) return unavailable("artifact_not_regular");
    const same = (right: typeof before): boolean => right.isFile() && before.dev === right.dev && before.ino === right.ino &&
      before.size === right.size && before.mtimeNs === right.mtimeNs && before.ctimeNs === right.ctimeNs;
    const fd = openSync(reference.path, "r");
    try {
      if (!same(fstatSync(fd, { bigint: true }))) return unavailable("artifact_changed");
      if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable("artifact_size_unavailable");
      if (!same(fstatSync(fd, { bigint: true })) || !same(lstatSync(reference.path, { bigint: true }))) return unavailable("artifact_changed");
      return Object.freeze({ ...reference, availability: "available", bytes_total: Number(before.size), modified_at: before.mtime.toISOString() });
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return observed ? unavailable("artifact_changed")
      : Object.freeze({ ...reference, availability: "missing" });
    return unavailable("artifact_unreadable");
  }
}

function hashArtifactFile(path: string): { sha256: string; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const bytesRead = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.byteLength, size - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: hash.digest("hex"), size: position };
  } finally {
    closeSync(fd);
  }
}

export function resolveArtifactPaths(
  artifacts: Record<string, RunArtifactDeclaration> | undefined,
  values: Record<string, unknown>,
): Record<string, RunArtifactDeclaration> | undefined {
  if (!artifacts) return undefined;
  const resolved: Record<string, RunArtifactDeclaration> = {};
  for (const [key, value] of Object.entries(artifacts)) {
    if (!key.trim()) continue;
    if (typeof value === "string") {
      resolved[key] = substituteCommandTemplateToken(
        value,
        values,
        `recipe artifacts.${key}`,
      );
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.path === "string"
    ) {
      resolved[key] = {
        ...value,
        path: substituteCommandTemplateToken(
          value.path,
          values,
          `recipe artifacts.${key}.path`,
        ),
      };
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveArtifactManifest(
  artifacts: Record<string, RunArtifactDeclaration> | undefined,
): Record<string, RunArtifactManifestEntry> | undefined {
  if (!artifacts) return undefined;
  const manifest: Record<string, RunArtifactManifestEntry> = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    const declaration =
      typeof artifact === "string" ? { path: artifact } : artifact;
    if (!declaration?.path) continue;
    try {
      const hashed = hashArtifactFile(declaration.path);
      manifest[name] = {
        exists: true,
        ...(declaration.kind ? { kind: declaration.kind } : {}),
        ...(declaration.media_type
          ? { media_type: declaration.media_type }
          : {}),
        path: declaration.path,
        ...(declaration.required !== undefined
          ? { required: declaration.required }
          : {}),
        sha256: hashed.sha256,
        size: hashed.size,
      };
    } catch {
      manifest[name] = {
        exists: false,
        ...(declaration.kind ? { kind: declaration.kind } : {}),
        ...(declaration.media_type
          ? { media_type: declaration.media_type }
          : {}),
        path: declaration.path,
        ...(declaration.required !== undefined
          ? { required: declaration.required }
          : {}),
      };
    }
  }
  return Object.keys(manifest).length > 0 ? manifest : undefined;
}
