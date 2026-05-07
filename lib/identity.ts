/**
 * Identifier normalization helpers
 * Zones: registry identity, shared validation
 * Owns stable tool, argument, and file-label identifier normalization
 */

export function normalizeIdentifier(value: string, prefix: string): string {
  let name = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return "";
  if (/^[0-9]/.test(name)) name = `${prefix}_${name}`;
  return name.slice(0, 64).replace(/_+$/g, "");
}

export function normalizeToolName(value: string): string {
  return normalizeIdentifier(value, "tool");
}

export function normalizeArgName(value: string): string {
  return normalizeIdentifier(value, "arg");
}

export function sanitizeFilePart(value: string): string {
  return normalizeIdentifier(value, "tool") || "tool";
}
