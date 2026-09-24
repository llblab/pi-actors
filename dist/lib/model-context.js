/**
 * Current model/thinking propagation helpers
 * Zones: pi session context, recipe inheritance
 * Owns current model/thinking extraction from Pi tool contexts and implicit command-template values.
 */
export const CURRENT_MODEL_VALUE_KEY = "current_model";
export const CURRENT_THINKING_VALUE_KEY = "current_thinking";
export function getCurrentModelPattern(ctx) {
    const provider = ctx?.model?.provider;
    const id = ctx?.model?.id ?? ctx?.model?.modelId;
    if (typeof provider !== "string" || !provider.trim())
        return undefined;
    if (typeof id !== "string" || !id.trim())
        return undefined;
    return `${provider.trim()}/${id.trim()}`;
}
function normalizeThinkingLevel(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function getSessionThinkingLevel(ctx) {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch))
        return undefined;
    for (const entry of [...branch].reverse()) {
        if (!entry || typeof entry !== "object")
            continue;
        const record = entry;
        if (record.type !== "thinking_level_change")
            continue;
        const level = normalizeThinkingLevel(record.thinkingLevel);
        if (level)
            return level;
    }
    return undefined;
}
export function getCurrentThinkingLevel(ctx) {
    return (normalizeThinkingLevel(ctx?.currentThinking) ??
        normalizeThinkingLevel(ctx?.thinkingLevel) ??
        normalizeThinkingLevel(ctx?.getThinkingLevel?.()) ??
        getSessionThinkingLevel(ctx));
}
export function withCurrentModelValues(values, ctx) {
    const currentModel = getCurrentModelPattern(ctx);
    const currentThinking = getCurrentThinkingLevel(ctx);
    if (!currentModel && !currentThinking)
        return values;
    return {
        ...values,
        ...(currentModel ? { [CURRENT_MODEL_VALUE_KEY]: currentModel } : {}),
        ...(currentThinking
            ? { [CURRENT_THINKING_VALUE_KEY]: currentThinking }
            : {}),
    };
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function stringReferencesPlaceholder(value, placeholder) {
    return new RegExp(`\\{\\s*${placeholder}\\s*\\}`).test(value);
}
function modelPolicyKeyMatches(key) {
    return /(^|_)models?$/.test(key);
}
function thinkingPolicyKeyMatches(key) {
    return /(^|_)(thinking|thinking_level)$/.test(key);
}
function argName(token) {
    if (typeof token !== "string")
        return undefined;
    return token.split(":")[0]?.trim() || undefined;
}
function collectPolicyDefaults(value, placeholder, path = "template", keys = new Set()) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectPolicyDefaults(item, placeholder, `${path}[${index}]`, keys));
        return keys;
    }
    if (!isRecord(value))
        return keys;
    for (const [key, child] of Object.entries(value)) {
        if (key === "defaults" && isRecord(child)) {
            for (const [defaultKey, defaultValue] of Object.entries(child)) {
                if (typeof defaultValue === "string" &&
                    stringReferencesPlaceholder(defaultValue, placeholder)) {
                    keys.add(defaultKey);
                }
            }
            continue;
        }
        collectPolicyDefaults(child, placeholder, `${path}.${key}`, keys);
    }
    return keys;
}
function collectPolicyDirectRefs(value, placeholder, path = "template", refs = new Set()) {
    if (typeof value === "string") {
        if (stringReferencesPlaceholder(value, placeholder))
            refs.add(path);
        return refs;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectPolicyDirectRefs(item, placeholder, `${path}[${index}]`, refs));
        return refs;
    }
    if (!isRecord(value))
        return refs;
    for (const [key, child] of Object.entries(value)) {
        if (key === "defaults")
            continue;
        collectPolicyDirectRefs(child, placeholder, `${path}.${key}`, refs);
    }
    return refs;
}
function summarizePolicyAxis(input) {
    const explicitKeys = Object.keys(input.explicitValues)
        .filter((key) => key !== CURRENT_MODEL_VALUE_KEY &&
        key !== CURRENT_THINKING_VALUE_KEY &&
        input.explicitKeyMatches(key))
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
    const source = unresolvedKeys.length
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
function collectPolicyDefaultsAcross(items, placeholder) {
    return items.reduce((keys, item) => collectPolicyDefaults(item, placeholder, "template", keys), new Set());
}
function collectPolicyDirectRefsAcross(items, placeholder) {
    return items.reduce((refs, item) => collectPolicyDirectRefs(item, placeholder, "template", refs), new Set());
}
export function describeCurrentPolicyProvenance(input) {
    const explicitValues = input.values ?? {};
    const defaultsEnvelope = input.defaults ? { defaults: input.defaults } : {};
    const templateAndDefaults = [defaultsEnvelope, input.template];
    return {
        model: summarizePolicyAxis({
            currentValue: typeof explicitValues[CURRENT_MODEL_VALUE_KEY] === "string"
                ? String(explicitValues[CURRENT_MODEL_VALUE_KEY])
                : undefined,
            directRefKey: CURRENT_MODEL_VALUE_KEY,
            directRefs: collectPolicyDirectRefsAcross(templateAndDefaults, "current_model"),
            explicitKeyMatches: modelPolicyKeyMatches,
            explicitValues,
            inheritedDefaultKeys: collectPolicyDefaultsAcross(templateAndDefaults, "current_model"),
        }),
        thinking: summarizePolicyAxis({
            currentValue: typeof explicitValues[CURRENT_THINKING_VALUE_KEY] === "string"
                ? String(explicitValues[CURRENT_THINKING_VALUE_KEY])
                : undefined,
            directRefKey: CURRENT_THINKING_VALUE_KEY,
            directRefs: collectPolicyDirectRefsAcross(templateAndDefaults, "current_thinking"),
            explicitKeyMatches: thinkingPolicyKeyMatches,
            explicitValues,
            inheritedDefaultKeys: collectPolicyDefaultsAcross(templateAndDefaults, "current_thinking"),
        }),
    };
}
function publicPolicyArgs(args, matches) {
    return Array.isArray(args)
        ? args
            .map(argName)
            .filter((key) => Boolean(key && matches(key)))
            .sort()
        : [];
}
function nonEmptyAxisRecipeSummary(inheritedDefaults, publicArgs) {
    if (inheritedDefaults.length === 0 && publicArgs.length === 0)
        return undefined;
    return {
        ...(inheritedDefaults.length
            ? { inherited_defaults: inheritedDefaults }
            : {}),
        ...(publicArgs.length ? { public_args: publicArgs } : {}),
    };
}
export function describeRecipeCurrentPolicy(input) {
    const templateAndDefaults = [
        input.defaults ? { defaults: input.defaults } : {},
        input.template,
    ];
    const model = nonEmptyAxisRecipeSummary([...collectPolicyDefaultsAcross(templateAndDefaults, "current_model")].sort(), publicPolicyArgs(input.args, modelPolicyKeyMatches));
    const thinking = nonEmptyAxisRecipeSummary([
        ...collectPolicyDefaultsAcross(templateAndDefaults, "current_thinking"),
    ].sort(), publicPolicyArgs(input.args, thinkingPolicyKeyMatches));
    if (!model && !thinking)
        return undefined;
    return {
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
    };
}
