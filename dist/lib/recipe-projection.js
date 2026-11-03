/**
 * Captured Recipe evidence projection.
 * Owns: shared Recipe/launch privacy normalization, known runtime-origin scrubbing and pure captured-secret/reference comparison policy.
 * Excludes: filesystem reads, identity admission, live Recipe resolution, export writes and native authority.
 */
import { isAbsolute, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { redactSessionEvidenceValue } from "./session-evidence.js";
function privateOriginScrubber(meta) {
    const origins = new Set();
    const collect = (value, actorContext = false) => {
        if (Array.isArray(value)) {
            value.forEach(item => collect(item));
            return;
        }
        if (!value || typeof value !== "object")
            return;
        for (const [key, item] of Object.entries(value)) {
            if ((["recipe_file", "source_file", "recipe_dir", "skill_dir"].includes(key) || (actorContext && key === "file")) &&
                typeof item === "string" && item && (isAbsolute(item) || win32.isAbsolute(item)))
                origins.add(item);
            collect(item, key === "actorRecipeContext");
        }
    };
    collect({ recipe_file: meta.recipe_file, contexts: meta.recipe_context_records, values: meta.values,
        template: meta.template, singleton_values: meta.singleton_values });
    const longestFirst = [...origins].sort((a, b) => b.length - a.length);
    // A directory suffix in a logical reference is not an absolute runtime-origin token.
    return value => longestFirst.reduce((text, origin) => text.replaceAll(origin, (match, offset) => /[\p{L}\p{N}_.-]$/u.test(text.slice(0, offset)) ? match : "[PRIVATE_RECIPE_ORIGIN]"), value);
}
/** Pure Recipe-provenance privacy for captured evidence; this callback grants no runtime authority. */
export function createRunRecipeEvidenceRedactor(meta, maxTextChars) {
    const scrubOrigin = privateOriginScrubber(meta);
    const stripPrivateOrigins = (value) => {
        if (typeof value === "string")
            return scrubOrigin(value);
        if (Array.isArray(value))
            return value.map(stripPrivateOrigins);
        if (!value || typeof value !== "object")
            return value;
        return Object.fromEntries(Object.entries(value)
            .filter(([key, entry]) => entry !== undefined &&
            key !== "recipe_dir" &&
            key !== "skill_dir" &&
            key !== "source_file")
            .map(([key, entry]) => [
            scrubOrigin(key),
            key === "actorRecipeContext" && entry && typeof entry === "object"
                ? stripPrivateOrigins(Object.fromEntries(Object.entries(entry).filter(([contextKey]) => contextKey !== "file")))
                : stripPrivateOrigins(entry),
        ]));
    };
    return value => redactSessionEvidenceValue(stripPrivateOrigins(value), maxTextChars);
}
function capturedSecretLiterals(meta) {
    const literals = new Set();
    const collect = (value, sensitive = false) => {
        if (typeof value === "string") {
            if (sensitive && value)
                literals.add(value);
            return;
        }
        if (!value || typeof value !== "object")
            return;
        for (const [key, child] of Object.entries(value)) {
            const privateKey = redactSessionEvidenceValue({ [key]: "" })[key] === "[REDACTED]";
            collect(child, sensitive || privateKey);
        }
    };
    collect(meta);
    return [...literals].sort((a, b) => b.length - a.length);
}
/** Literal sensitive-key privacy from captured data; does not admit metadata, references or producers. */
export function capturedSecretMask(meta, replacement = "[REDACTED]") {
    const escaped = capturedSecretLiterals(meta).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const secrets = escaped.length ? new RegExp(escaped.join("|"), "gu") : undefined;
    return text => secrets ? text.replace(secrets, () => replacement) : text;
}
function capturedBodyPolicy(meta) {
    const project = createRunRecipeEvidenceRedactor(meta, Number.MAX_SAFE_INTEGER), mask = capturedSecretMask(meta), literals = capturedSecretLiterals(meta);
    const encoded = (value) => {
        const bom = value.startsWith("\uFEFF");
        let parsed;
        try {
            parsed = JSON.parse(bom ? value.slice(1) : value);
        }
        catch {
            return undefined;
        }
        const present = literals.filter(literal => value.includes(literal));
        if (present.length) {
            // Probe only: never emit masked JSON or use its altered keys for sensitive-key decisions.
            if (present.some(literal => JSON.stringify(literal).slice(1, -1) !== literal))
                return "[REDACTED]";
            try {
                const masked = mask(value);
                JSON.parse(bom ? masked.slice(1) : masked);
            }
            catch {
                return "[REDACTED]";
            }
        }
        // Decode structured text before generic masking can alter its syntax; nested encoded content follows the same policy.
        const projected = full(parsed);
        return JSON.stringify(projected) === JSON.stringify(parsed) ? value : (bom ? "\uFEFF" : "") + JSON.stringify(projected);
    };
    const prepare = (value) => {
        if (typeof value === "string")
            return encoded(value) ?? value;
        if (Array.isArray(value))
            return value.map(prepare);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prepare(item)]));
        return value;
    };
    const scrub = (value) => {
        if (typeof value === "string")
            return mask(value);
        if (Array.isArray(value))
            return value.map(scrub);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [mask(key), scrub(item)]));
        return value;
    };
    const full = (value) => scrub(project(prepare(value)));
    return { full, encoded };
}
/** Original-publication body policy for already-admitted data; defaults elsewhere remain per-call origin/generic privacy. */
export function createRunRecipeBodyRedactor(meta, maxTextChars) {
    const { full } = capturedBodyPolicy(meta);
    // All recorded content privacy precedes the existing display limit; no identity/source permission is minted.
    return value => redactSessionEvidenceValue(full(value), maxTextChars);
}
/** Complete source text keeps public JSON spelling/BOM; never project its serialized protected JSON a second time. */
export function createRunRecipeTextRedactor(meta) {
    const { full, encoded } = capturedBodyPolicy(meta);
    return text => {
        const projected = encoded(text) ?? full(text);
        if (typeof projected !== "string")
            throw new Error("Run captured text privacy must return text.");
        return projected;
    };
}
/** Pure comparison for already-admitted closed reference data, never identity/source/body authority. */
export function createContextIdentityPrivacyCheck(original) {
    const redact = createRunRecipeEvidenceRedactor(original, Number.MAX_SAFE_INTEGER), withoutSecrets = capturedSecretMask(original, "");
    // Removal detects presence even when an original credential literally equals the display replacement token.
    return identity => isDeepStrictEqual(redact(identity), identity) && Object.values(identity).every(value => typeof value !== "string" || withoutSecrets(value) === value);
}
export function projectRunRecipe(meta, diagnostics = [], redactEvidence = createRunRecipeEvidenceRedactor(meta)) {
    const contexts = Array.isArray(meta.recipe_context_records)
        ? meta.recipe_context_records.filter((entry) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
        : [];
    const primary = contexts.find((entry) => entry.depth === 0) ?? contexts[0];
    const definition = primary?.recipe &&
        typeof primary.recipe === "object" &&
        !Array.isArray(primary.recipe)
        ? primary.recipe
        : undefined;
    const redactedRecord = (value) => redactEvidence(value);
    const primarySourceKind = primary?.source_kind === "active_skill_component"
        ? "active_skill_component"
        : primary?.source_kind === "user_registry_capability" ||
            meta.launch_source === "tool"
            ? "user_registry_capability"
            : "explicit_file_recipe";
    const primaryLogicalReference = typeof primary?.logical_reference === "string"
        ? primary.logical_reference
        : typeof primary?.name === "string"
            ? primary.name
            : typeof meta.recipe === "string"
                ? meta.recipe
                : "unknown";
    const launchValues = meta.values && typeof meta.values === "object" && !Array.isArray(meta.values)
        ? Object.fromEntries(Object.entries(meta.values).filter(([key]) => key !== "recipe_dir" && key !== "skill_dir"))
        : meta.values;
    return {
        composition: contexts.map((entry) => redactedRecord({
            ...(typeof entry.alias === "string" ? { alias: entry.alias } : {}),
            depth: entry.depth,
            import_path: entry.import_path,
            logical_reference: entry.logical_reference ?? entry.name,
            recipe_stem: entry.name,
            role: entry.role,
            ...(typeof entry.skill === "string" ? { skill: entry.skill } : {}),
            source_kind: entry.source_kind === "active_skill_component"
                ? "active_skill_component"
                : entry.source_kind === "user_registry_capability" ||
                    (entry.depth === 0 && meta.launch_source === "tool")
                    ? "user_registry_capability"
                    : "explicit_file_recipe",
        })),
        ...(definition ? { definition: redactedRecord(definition) } : {}),
        diagnostics: diagnostics.map(value => redactEvidence(value)),
        identity: redactedRecord({
            run: meta.run,
            recipe: meta.recipe,
            recipe_stem: primary?.name ?? meta.recipe,
            logical_reference: primaryLogicalReference,
            ...(typeof primary?.skill === "string" ? { skill: primary.skill } : {}),
            source_kind: primarySourceKind,
            launch_kind: meta.launch_kind ?? meta.launch_source,
            launch_source: meta.launch_source,
            ...(meta.singleton === true
                ? { singleton: true, singleton_recipe_id: meta.singleton_recipe_id }
                : {}),
        }),
        launch: redactedRecord({
            cwd: meta.cwd,
            template: meta.template,
            values: launchValues,
            model_policy: meta.model_policy,
            control: meta.control,
            artifacts: meta.artifacts,
            notification_policy: meta.notification_policy,
            retire_when: meta.retire_when,
            singleton_values: meta.singleton_values,
        }),
    };
}
