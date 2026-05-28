/**
 * File-discovered recipe registry helpers
 * Zones: recipe discovery, tool exposure, migration diagnostics
 * Owns filename identity discovery across prioritized recipe roots
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import * as CommandTemplates from "./command-templates.ts";
import type { RegisteredTool } from "./config.ts";
import type { TemplateRecipeConfig } from "./recipe-references.ts";
import * as RecipeReferences from "./recipe-references.ts";
import * as Schema from "./schema.ts";

export interface DiscoveredRecipe {
  id: string;
  path: string;
  root: string;
  priority: number;
  config?: TemplateRecipeConfig;
  active: boolean;
  shadowed: boolean;
  invalid: boolean;
  disabled: boolean;
  tool: boolean;
  mutableUsage: boolean;
  diagnostics: string[];
  shadows: string[];
}

export interface RecipeIntegrityManifestEntry {
  id: string;
  path: string;
  root: string;
  sha256: string;
  size: number;
  tool: boolean;
  active: boolean;
  invalid: boolean;
  disabled: boolean;
  shadowed: boolean;
}

export interface RecipeDiscoveryResult {
  active: Map<string, DiscoveredRecipe>;
  entries: DiscoveredRecipe[];
  diagnostics: string[];
}

export interface RecipeDiscoverySource {
  root?: string;
  file?: string;
  defaultTool?: boolean;
  mutableUsage?: boolean;
}

function assertToolSafeRepeatConfig(
  config: unknown,
  argTypes: Record<string, { kind: string }>,
  defaults: Record<string, unknown>,
): void {
  if (typeof config === "string" || config === undefined || config === null)
    return;
  if (Array.isArray(config)) {
    for (const step of config)
      assertToolSafeRepeatConfig(step, argTypes, defaults);
    return;
  }
  if (typeof config !== "object") return;
  const node = config as {
    repeat?: unknown;
    template?: unknown;
    recover?: unknown;
  };
  if (typeof node.repeat === "string") {
    const trimmed = node.repeat.trim();
    if (!/^\d+$/.test(trimmed)) {
      const match = trimmed.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\.length\}?$/);
      if (
        !match ||
        (argTypes[match[1]]?.kind !== "array" &&
          !Array.isArray(defaults[match[1]]))
      )
        throw new Error(
          "Command template repeat must be a positive integer or {array.length} with an array argument/default.",
        );
    }
  }
  assertToolSafeRepeatConfig(node.template, argTypes, defaults);
  assertToolSafeRepeatConfig(node.recover, argTypes, defaults);
}

function listRecipeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".md")) &&
        entry.name !== "legacy-tool-registry-migration-report.json",
    )
    .map((entry) => join(root, entry.name))
    .sort(
      (a, b) =>
        a
          .replace(/\.md$/, ".json")
          .localeCompare(b.replace(/\.md$/, ".json")) ||
        (a.endsWith(".json") ? -1 : 1),
    );
}

function getRecipeConfigDiagnostics(
  file: string,
  config: TemplateRecipeConfig | undefined,
): string[] {
  if (!config) {
    const reason = RecipeReferences.diagnoseRawRecipeConfigFailure(file);
    return [`Invalid recipe: ${file}${reason ? `: ${reason}` : ""}`];
  }
  const commandTemplateConfig =
    typeof config.template === "object" && config.template !== null
      ? config.template
      : config;
  return CommandTemplates.getCommandTemplateWarnings(
    commandTemplateConfig as CommandTemplates.CommandTemplateConfig,
  ).map((warning) => `Recipe ${file}: ${warning}`);
}

function readDiscoveredRecipe(
  root: string,
  file: string,
  priority: number,
  defaultTool = false,
  mutableUsage = false,
): DiscoveredRecipe {
  const id = RecipeReferences.getRecipeIdFromPath(file);
  try {
    const config = RecipeReferences.readResolvedRecipeConfig(file);
    const invalid = !config;
    const disabled = config?.disabled === true;
    return {
      id,
      path: file,
      root,
      priority,
      config,
      active: false,
      shadowed: false,
      invalid,
      disabled,
      tool: defaultTool && !disabled && !invalid,
      mutableUsage,
      diagnostics: getRecipeConfigDiagnostics(file, config),
      shadows: [],
    };
  } catch (error) {
    return {
      id,
      path: file,
      root,
      priority,
      active: false,
      shadowed: false,
      invalid: true,
      disabled: false,
      tool: false,
      mutableUsage,
      diagnostics: [
        `Failed to load recipe ${file}: ${error instanceof Error ? error.message : String(error)}`,
      ],
      shadows: [],
    };
  }
}

function filesForSource(source: RecipeDiscoverySource): Array<{
  root: string;
  file: string;
  defaultTool: boolean;
  mutableUsage: boolean;
}> {
  const defaultTool = source.defaultTool === true;
  const mutableUsage = source.mutableUsage === true;
  if (source.file)
    return [
      {
        root: source.root ?? source.file,
        file: source.file,
        defaultTool,
        mutableUsage,
      },
    ];
  return source.root
    ? listRecipeFiles(source.root).map((file) => ({
        root: source.root!,
        file,
        defaultTool,
        mutableUsage,
      }))
    : [];
}

function getRecipeRootDiagnostics(sources: RecipeDiscoverySource[]): string[] {
  const diagnostics: string[] = [];
  const roots = new Set(
    sources
      .map((source) => source.root)
      .filter((root): root is string => typeof root === "string"),
  );
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      const stat = statSync(root);
      if ((stat.mode & 0o002) !== 0) {
        diagnostics.push(
          `Recipe root is world-writable; review permissions: ${root}`,
        );
      }
      if ((stat.mode & 0o020) !== 0) {
        diagnostics.push(
          `Recipe root is group-writable; review ownership and permissions: ${root}`,
        );
      }
    } catch (error) {
      diagnostics.push(
        `Failed to inspect recipe root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return diagnostics;
}

export function discoverRecipeSources(
  sources: RecipeDiscoverySource[],
): RecipeDiscoveryResult {
  const entries = sources.flatMap((source, priority) =>
    filesForSource(source).map(({ root, file, defaultTool, mutableUsage }) =>
      readDiscoveredRecipe(root, file, priority, defaultTool, mutableUsage),
    ),
  );
  const byId = new Map<string, DiscoveredRecipe[]>();
  for (const entry of entries) {
    const bucket = byId.get(entry.id) ?? [];
    bucket.push(entry);
    byId.set(entry.id, bucket);
  }

  const active = new Map<string, DiscoveredRecipe>();
  const diagnostics: string[] = getRecipeRootDiagnostics(sources);
  for (const [id, bucket] of byId) {
    bucket.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.path
          .replace(/\.md$/, ".json")
          .localeCompare(b.path.replace(/\.md$/, ".json")) ||
        (a.path.endsWith(".json") ? -1 : 1),
    );
    const winner = bucket[0];
    winner.active = true;
    winner.shadows = bucket.slice(1).map((entry) => entry.path);
    active.set(id, winner);
    for (const shadow of bucket.slice(1)) {
      shadow.shadowed = true;
      if (winner.path.endsWith(".json") && shadow.path.endsWith(".md"))
        shadow.diagnostics.push(
          `Markdown recipe ${shadow.path} is shadowed by JSON recipe ${winner.path}`,
        );
    }
    if (winner.invalid)
      diagnostics.push(
        `Recipe ${id} is invalid and blocks lower-priority recipes`,
      );
    if (winner.disabled)
      diagnostics.push(
        `Recipe ${id} is disabled and blocks lower-priority recipes`,
      );
    if (winner.shadows.length > 0)
      diagnostics.push(
        `Recipe ${id} shadows ${winner.shadows.length} lower-priority recipe(s)`,
      );
    diagnostics.push(...winner.diagnostics);
  }

  return { active, entries, diagnostics };
}

export function discoverRecipes(roots: string[]): RecipeDiscoveryResult {
  return discoverRecipeSources(roots.map((root) => ({ root })));
}

function recipeUsage(
  config: TemplateRecipeConfig | undefined,
): Record<string, unknown> | undefined {
  const usage = (config as { usage?: unknown } | undefined)?.usage;
  return usage && typeof usage === "object" && !Array.isArray(usage)
    ? (usage as Record<string, unknown>)
    : undefined;
}

function cleanupRecommendation(
  entry: DiscoveredRecipe,
): Record<string, unknown> | undefined {
  if (entry.invalid) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "invalid recipe blocks lower-priority entries with the same id",
      actions: ["fix", "delete", "archive"],
    };
  }
  if (entry.shadowed) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "shadowed by a higher-priority recipe",
      actions: ["merge", "delete", "archive"],
    };
  }
  if (entry.disabled) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "disabled recipe is retained but not exposed as a tool",
      actions: ["keep disabled", "delete", "archive"],
    };
  }
  const usage = recipeUsage(entry.config);
  const calls = Number(usage?.calls ?? 0);
  if (entry.mutableUsage && entry.tool && calls === 0) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "active user tool has no recorded launches",
      actions: ["keep as tool", "move out of tool root", "delete", "archive"],
    };
  }
  if (entry.mutableUsage && !entry.tool) {
    return {
      id: entry.id,
      path: entry.path,
      reason: "user recipe is a component, not an active tool",
      actions: [
        "keep component",
        "move into tool root",
        "merge",
        "delete",
        "archive",
      ],
    };
  }
  if (entry.shadows.length > 0) {
    return {
      id: entry.id,
      path: entry.path,
      reason: `overrides ${entry.shadows.length} lower-priority recipe(s)`,
      actions: ["keep override", "merge", "delete", "archive"],
    };
  }
  return undefined;
}

export function createRecipeIntegrityManifest(
  result: RecipeDiscoveryResult,
): RecipeIntegrityManifestEntry[] {
  return result.entries
    .map((entry) => {
      const bytes = readFileSync(entry.path);
      return {
        active: entry.active,
        disabled: entry.disabled,
        id: entry.id,
        invalid: entry.invalid,
        path: entry.path,
        root: entry.root,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        shadowed: entry.shadowed,
        size: bytes.byteLength,
        tool: entry.tool,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}

function diagnosticSeverity(message: string): "info" | "warning" | "error" {
  if (
    /invalid|failed to load|not found|cyclic|exceeds|must define|repeat must/i.test(
      message,
    )
  ) {
    return "error";
  }
  if (
    /world-writable|group-writable|invokes bash|eval|destructive|unsafe/i.test(
      message,
    )
  ) {
    return "warning";
  }
  return "info";
}

function diagnosticSuggestedAction(message: string): string {
  if (/world-writable|group-writable/i.test(message))
    return "tighten recipe root permissions";
  if (/invokes bash/i.test(message))
    return "audit the trusted shell boundary and keep only if intentional";
  if (/must define template/i.test(message))
    return "add a template field or remove the recipe";
  if (/JSON|Expected|parse/i.test(message))
    return "fix recipe syntax or archive the file";
  if (/Markdown recipe/i.test(message))
    return "fix frontmatter and add a fenced template or recipe block";
  if (/cyclic/i.test(message)) return "break the import cycle";
  if (/exceeds.*size/i.test(message))
    return "split large prompt or data into separate files";
  if (/repeat must/i.test(message))
    return "use a positive repeat count or an array-typed repeat source";
  if (/shadows/i.test(message))
    return "confirm the active override or rename one recipe";
  if (/disabled/i.test(message))
    return "keep disabled intentionally or delete/archive the file";
  return "inspect the recipe and fix or archive it if unexpected";
}

function diagnosticDetails(
  result: RecipeDiscoveryResult,
): Array<Record<string, unknown>> {
  const details: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (message: string, entry?: DiscoveredRecipe): void => {
    const key = `${entry?.path ?? "root"}\n${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push({
      ...(entry ? { id: entry.id, path: entry.path } : {}),
      action: diagnosticSuggestedAction(message),
      message,
      severity: diagnosticSeverity(message),
    });
  };
  for (const message of result.diagnostics) push(message);
  for (const entry of result.entries) {
    for (const message of entry.diagnostics) push(message, entry);
  }
  return details.sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return (
      rank[a.severity as keyof typeof rank] -
        rank[b.severity as keyof typeof rank] ||
      String(a.message).localeCompare(String(b.message))
    );
  });
}

function remediationForEntry(
  entry: DiscoveredRecipe,
  activePath: string | undefined,
): Record<string, unknown> | undefined {
  const riskyDiagnostics = entry.diagnostics.filter(
    (message) => diagnosticSeverity(message) === "warning",
  );
  const blockedCandidate = entry.shadows[0];
  if (entry.invalid) {
    return {
      id: entry.id,
      kind: blockedCandidate ? "blocking_invalid" : "invalid",
      severity: "error",
      path: entry.path,
      ...(blockedCandidate ? { blocked_candidate: blockedCandidate } : {}),
      reason: blockedCandidate
        ? "invalid higher-priority recipe blocks a lower-priority candidate"
        : "recipe is invalid and cannot be exposed as a tool",
      action:
        "fix recipe syntax/config, or disable/delete/archive it to restore fallback",
    };
  }
  if (entry.disabled && entry.active) {
    return {
      id: entry.id,
      kind: blockedCandidate ? "blocking_disabled" : "disabled",
      severity: "warning",
      path: entry.path,
      ...(blockedCandidate ? { blocked_candidate: blockedCandidate } : {}),
      reason: blockedCandidate
        ? "disabled higher-priority recipe intentionally blocks a lower-priority candidate"
        : "recipe is disabled and not exposed as a tool",
      action:
        "keep disabled intentionally, re-enable, or delete/archive the file",
    };
  }
  if (riskyDiagnostics.length > 0) {
    return {
      id: entry.id,
      kind: "risky_shell_boundary",
      severity: "warning",
      path: entry.path,
      reason: riskyDiagnostics[0],
      action:
        "audit trusted command boundary; keep only if the recipe is local and intentional",
    };
  }
  if (entry.shadowed) {
    return {
      id: entry.id,
      kind: "shadowed",
      severity: "info",
      path: entry.path,
      ...(activePath ? { active_path: activePath } : {}),
      reason: activePath
        ? `shadowed by ${activePath}`
        : "shadowed by a higher-priority recipe",
      action: "keep as fallback/component, merge, rename, delete, or archive",
    };
  }
  return undefined;
}

function remediationRank(item: Record<string, unknown>): number {
  const kind = String(item.kind ?? "");
  if (kind === "blocking_invalid") return 0;
  if (kind === "invalid") return 1;
  if (kind === "blocking_disabled") return 2;
  if (kind === "risky_shell_boundary") return 3;
  if (kind === "disabled") return 4;
  if (kind === "shadowed") return 5;
  return 6;
}

function discoveryRemediations(
  result: RecipeDiscoveryResult,
): Array<Record<string, unknown>> {
  return result.entries
    .map((entry) =>
      remediationForEntry(entry, result.active.get(entry.id)?.path),
    )
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .sort(
      (a, b) =>
        remediationRank(a) - remediationRank(b) ||
        String(a.id).localeCompare(String(b.id)) ||
        String(a.path).localeCompare(String(b.path)),
    );
}

function recommendationForEntry(
  entry: DiscoveredRecipe,
  activePath: string | undefined,
): Record<string, unknown> | undefined {
  const recommendation = cleanupRecommendation(entry);
  if (!recommendation) return undefined;
  if (entry.shadowed && activePath) {
    return {
      ...recommendation,
      reason: `shadowed by ${activePath}`,
    };
  }
  return recommendation;
}

export function getShadowedLaunchDiagnostic(
  result: RecipeDiscoveryResult,
  id: string,
): Record<string, unknown> | undefined {
  const active = result.active.get(id.trim());
  if (!active || active.shadows.length === 0) return undefined;
  if (!active.invalid && !active.disabled) return undefined;
  return {
    active_path: active.path,
    blocked_candidate: active.shadows[0],
    hint: "inspect_recipes_doctor",
    reason: active.invalid ? "shadowed_invalid" : "shadowed_disabled",
  };
}

export function summarizeDiscovery(
  result: RecipeDiscoveryResult,
): Record<string, unknown> {
  const recommendations = result.entries
    .map((entry) =>
      recommendationForEntry(entry, result.active.get(entry.id)?.path),
    )
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .sort(
      (a, b) =>
        String(a.id).localeCompare(String(b.id)) ||
        String(a.path).localeCompare(String(b.path)),
    );
  const remediations = discoveryRemediations(result);
  return {
    active: [...result.active.values()]
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        description: entry.config?.description,
        tool: entry.tool,
        disabled: entry.disabled,
        invalid: entry.invalid,
        shadows: entry.shadows,
        ...(entry.config?.imports ? { imports: entry.config.imports } : {}),
        ...(recipeUsage(entry.config)
          ? { usage: recipeUsage(entry.config) }
          : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    shadowed: result.entries
      .filter((entry) => entry.shadowed)
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        shadowedBy: result.active.get(entry.id)?.path,
      }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)),
    invalid: result.entries
      .filter((entry) => entry.invalid)
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        diagnostics: entry.diagnostics,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    disabled: result.entries
      .filter((entry) => entry.disabled)
      .map((entry) => ({ id: entry.id, path: entry.path }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    recommendations,
    remediations,
    top_action: remediations[0],
    diagnostics: result.diagnostics,
    diagnostic_details: diagnosticDetails(result),
    integrity_manifest: createRecipeIntegrityManifest(result),
  };
}

export function toRegisteredTool(
  entry: DiscoveredRecipe,
): RegisteredTool | undefined {
  if (!entry.tool || entry.invalid || entry.disabled || !entry.config)
    return undefined;
  const cfg = entry.config;
  const template = entry.path;
  const description = cfg.description ?? `Execute template recipe: ${entry.id}`;
  const argTemplate = cfg.template;
  const argTemplateConfig =
    typeof argTemplate === "object" && !Array.isArray(argTemplate)
      ? {
          ...argTemplate,
          ...(cfg.args !== undefined ? { args: cfg.args } : {}),
          defaults: {
            ...(argTemplate.defaults ?? {}),
            ...(cfg.defaults ?? {}),
          },
        }
      : { args: cfg.args, defaults: cfg.defaults ?? {}, template: argTemplate };
  const explicitArgTypes = Object.fromEntries(
    (cfg.args ?? []).map((arg) => {
      const parsed = Schema.parseToolArgToken(String(arg));
      return [parsed.arg, parsed.type];
    }),
  );
  assertToolSafeRepeatConfig(
    argTemplateConfig,
    explicitArgTypes,
    cfg.defaults ?? {},
  );
  const argTypes = Schema.getTemplateArgTypes(argTemplateConfig);
  return {
    name: entry.id,
    description,
    template,
    recipe: cfg,
    args: Schema.getToolArgNames(argTemplateConfig),
    defaults: Object.fromEntries(
      Object.entries(cfg.defaults ?? {}).map(([key, value]) => [
        key,
        String(value),
      ]),
    ),
    ...(Object.keys(argTypes).length > 0 ? { argTypes } : {}),
    ...(entry.mutableUsage ? { sourcePath: entry.path } : {}),
    ...(cfg.args ? { storedArgs: cfg.args } : {}),
    ...(cfg.defaults
      ? {
          storedDefaults: Object.fromEntries(
            Object.entries(cfg.defaults).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }
      : {}),
  };
}
