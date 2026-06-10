/**
 * Current model/thinking propagation helpers
 * Zones: pi session context, recipe inheritance
 * Owns current model/thinking extraction from Pi tool contexts and implicit command-template values.
 */

export interface CurrentModelContext {
  currentThinking?: unknown;
  getThinkingLevel?: () => unknown;
  model?: {
    id?: unknown;
    modelId?: unknown;
    provider?: unknown;
  };
  sessionManager?: {
    getBranch?: () => unknown[];
    getSessionId?: () => string;
  };
  thinkingLevel?: unknown;
}

export const CURRENT_MODEL_VALUE_KEY = "current_model";
export const CURRENT_THINKING_VALUE_KEY = "current_thinking";

export type CurrentPolicySource =
  | "explicit"
  | "inherited"
  | "mixed"
  | "unresolved"
  | "unused";

export interface CurrentPolicyAxisProvenance {
  explicit_keys?: string[];
  inherited_keys?: string[];
  source: CurrentPolicySource;
  unresolved_keys?: string[];
  value?: string;
}

export interface CurrentPolicyProvenance {
  model: CurrentPolicyAxisProvenance;
  thinking: CurrentPolicyAxisProvenance;
}

export interface CurrentPolicyRecipeSummary {
  model?: {
    inherited_defaults?: string[];
    public_args?: string[];
  };
  thinking?: {
    inherited_defaults?: string[];
    public_args?: string[];
  };
}

export function getCurrentModelPattern(
  ctx: CurrentModelContext | undefined,
): string | undefined {
  const provider = ctx?.model?.provider;
  const id = ctx?.model?.id ?? ctx?.model?.modelId;
  if (typeof provider !== "string" || !provider.trim()) return undefined;
  if (typeof id !== "string" || !id.trim()) return undefined;
  return `${provider.trim()}/${id.trim()}`;
}

function normalizeThinkingLevel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getSessionThinkingLevel(
  ctx: CurrentModelContext | undefined,
): string | undefined {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return undefined;
  for (const entry of [...branch].reverse()) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "thinking_level_change") continue;
    const level = normalizeThinkingLevel(record.thinkingLevel);
    if (level) return level;
  }
  return undefined;
}

export function getCurrentThinkingLevel(
  ctx: CurrentModelContext | undefined,
): string | undefined {
  return (
    normalizeThinkingLevel(ctx?.currentThinking) ??
    normalizeThinkingLevel(ctx?.thinkingLevel) ??
    normalizeThinkingLevel(ctx?.getThinkingLevel?.()) ??
    getSessionThinkingLevel(ctx)
  );
}

export function withCurrentModelValues<T extends Record<string, unknown>>(
  values: T,
  ctx: CurrentModelContext | undefined,
): T & Record<string, unknown> {
  const currentModel = getCurrentModelPattern(ctx);
  const currentThinking = getCurrentThinkingLevel(ctx);
  if (!currentModel && !currentThinking) return values;
  return {
    ...values,
    ...(currentModel ? { [CURRENT_MODEL_VALUE_KEY]: currentModel } : {}),
    ...(currentThinking
      ? { [CURRENT_THINKING_VALUE_KEY]: currentThinking }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringReferencesPlaceholder(
  value: string,
  placeholder: string,
): boolean {
  return new RegExp(`\\{\\s*${placeholder}\\s*\\}`).test(value);
}

function modelPolicyKeyMatches(key: string): boolean {
  return /(^|_)models?$/.test(key);
}

function thinkingPolicyKeyMatches(key: string): boolean {
  return /(^|_)(thinking|thinking_level)$/.test(key);
}

function argName(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  return token.split(":")[0]?.trim() || undefined;
}

function collectPolicyDefaults(
  value: unknown,
  placeholder: string,
  path = "template",
  keys = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPolicyDefaults(item, placeholder, `${path}[${index}]`, keys),
    );
    return keys;
  }
  if (!isRecord(value)) return keys;
  for (const [key, child] of Object.entries(value)) {
    if (key === "defaults" && isRecord(child)) {
      for (const [defaultKey, defaultValue] of Object.entries(child)) {
        if (
          typeof defaultValue === "string" &&
          stringReferencesPlaceholder(defaultValue, placeholder)
        ) {
          keys.add(defaultKey);
        }
      }
      continue;
    }
    collectPolicyDefaults(child, placeholder, `${path}.${key}`, keys);
  }
  return keys;
}

function collectPolicyDirectRefs(
  value: unknown,
  placeholder: string,
  path = "template",
  refs = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (stringReferencesPlaceholder(value, placeholder)) refs.add(path);
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPolicyDirectRefs(item, placeholder, `${path}[${index}]`, refs),
    );
    return refs;
  }
  if (!isRecord(value)) return refs;
  for (const [key, child] of Object.entries(value)) {
    if (key === "defaults") continue;
    collectPolicyDirectRefs(child, placeholder, `${path}.${key}`, refs);
  }
  return refs;
}

function summarizePolicyAxis(input: {
  currentValue?: string;
  directRefKey: string;
  explicitKeyMatches: (key: string) => boolean;
  explicitValues: Record<string, unknown>;
  inheritedDefaultKeys: Set<string>;
  directRefs: Set<string>;
}): CurrentPolicyAxisProvenance {
  const explicitKeys = Object.keys(input.explicitValues)
    .filter(
      (key) =>
        key !== CURRENT_MODEL_VALUE_KEY &&
        key !== CURRENT_THINKING_VALUE_KEY &&
        input.explicitKeyMatches(key),
    )
    .sort();
  const inheritedKeys = [...input.inheritedDefaultKeys]
    .filter((key) => !Object.hasOwn(input.explicitValues, key))
    .sort();
  const directRefs = [...input.directRefs].length > 0 ? [input.directRefKey] : [];
  const inheritedOrDirect = [...new Set([...inheritedKeys, ...directRefs])].sort();
  const unresolvedKeys = input.currentValue ? [] : inheritedOrDirect;
  const inheritedResolvedKeys = input.currentValue ? inheritedOrDirect : [];
  const hasExplicit = explicitKeys.length > 0;
  const hasInherited = inheritedResolvedKeys.length > 0;
  const source: CurrentPolicySource = unresolvedKeys.length
    ? "unresolved"
    : hasExplicit && hasInherited
      ? "mixed"
      : hasExplicit
        ? "explicit"
        : hasInherited
          ? "inherited"
          : "unused";
  const explicitValue = explicitKeys
    .map((key) => input.explicitValues[key])
    .find((value) => typeof value === "string" && value.trim());
  const value = hasInherited
    ? input.currentValue
    : typeof explicitValue === "string"
      ? explicitValue
      : undefined;
  return {
    ...(explicitKeys.length ? { explicit_keys: explicitKeys } : {}),
    ...(inheritedResolvedKeys.length
      ? { inherited_keys: inheritedResolvedKeys }
      : {}),
    source,
    ...(unresolvedKeys.length ? { unresolved_keys: unresolvedKeys } : {}),
    ...(value ? { value } : {}),
  };
}

function collectPolicyDefaultsAcross(
  items: unknown[],
  placeholder: string,
): Set<string> {
  return items.reduce<Set<string>>(
    (keys, item) => collectPolicyDefaults(item, placeholder, "template", keys),
    new Set<string>(),
  );
}

function collectPolicyDirectRefsAcross(
  items: unknown[],
  placeholder: string,
): Set<string> {
  return items.reduce<Set<string>>(
    (refs, item) => collectPolicyDirectRefs(item, placeholder, "template", refs),
    new Set<string>(),
  );
}

export function describeCurrentPolicyProvenance(input: {
  defaults?: Record<string, unknown>;
  template: unknown;
  values?: Record<string, unknown>;
}): CurrentPolicyProvenance {
  const explicitValues = input.values ?? {};
  const defaultsEnvelope = input.defaults ? { defaults: input.defaults } : {};
  const templateAndDefaults = [defaultsEnvelope, input.template];
  return {
    model: summarizePolicyAxis({
      currentValue:
        typeof explicitValues[CURRENT_MODEL_VALUE_KEY] === "string"
          ? String(explicitValues[CURRENT_MODEL_VALUE_KEY])
          : undefined,
      directRefKey: CURRENT_MODEL_VALUE_KEY,
      directRefs: collectPolicyDirectRefsAcross(
        templateAndDefaults,
        "current_model",
      ),
      explicitKeyMatches: modelPolicyKeyMatches,
      explicitValues,
      inheritedDefaultKeys: collectPolicyDefaultsAcross(
        templateAndDefaults,
        "current_model",
      ),
    }),
    thinking: summarizePolicyAxis({
      currentValue:
        typeof explicitValues[CURRENT_THINKING_VALUE_KEY] === "string"
          ? String(explicitValues[CURRENT_THINKING_VALUE_KEY])
          : undefined,
      directRefKey: CURRENT_THINKING_VALUE_KEY,
      directRefs: collectPolicyDirectRefsAcross(
        templateAndDefaults,
        "current_thinking",
      ),
      explicitKeyMatches: thinkingPolicyKeyMatches,
      explicitValues,
      inheritedDefaultKeys: collectPolicyDefaultsAcross(
        templateAndDefaults,
        "current_thinking",
      ),
    }),
  };
}

function publicPolicyArgs(
  args: unknown,
  matches: (key: string) => boolean,
): string[] {
  return Array.isArray(args)
    ? args
        .map(argName)
        .filter((key): key is string => Boolean(key && matches(key)))
        .sort()
    : [];
}

function nonEmptyAxisRecipeSummary(
  inheritedDefaults: string[],
  publicArgs: string[],
): { inherited_defaults?: string[]; public_args?: string[] } | undefined {
  if (inheritedDefaults.length === 0 && publicArgs.length === 0)
    return undefined;
  return {
    ...(inheritedDefaults.length
      ? { inherited_defaults: inheritedDefaults }
      : {}),
    ...(publicArgs.length ? { public_args: publicArgs } : {}),
  };
}

export function describeRecipeCurrentPolicy(input: {
  args?: unknown;
  defaults?: Record<string, unknown>;
  template: unknown;
}): CurrentPolicyRecipeSummary | undefined {
  const templateAndDefaults = [
    input.defaults ? { defaults: input.defaults } : {},
    input.template,
  ];
  const model = nonEmptyAxisRecipeSummary(
    [...collectPolicyDefaultsAcross(templateAndDefaults, "current_model")].sort(),
    publicPolicyArgs(input.args, modelPolicyKeyMatches),
  );
  const thinking = nonEmptyAxisRecipeSummary(
    [
      ...collectPolicyDefaultsAcross(templateAndDefaults, "current_thinking"),
    ].sort(),
    publicPolicyArgs(input.args, thinkingPolicyKeyMatches),
  );
  if (!model && !thinking) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}
