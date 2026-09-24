/**
 * Template recipe reference helpers
 * Zones: registry config, async runs, path resolution
 * Owns detection, loading, and recipe-layer expansion for template recipe files
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import * as CommandTemplates from "./command-templates.js";
import * as Paths from "./paths.js";
import * as RecipeControl from "./recipe-control.js";
import * as Schema from "./schema.js";
const MAX_RECIPE_FILE_BYTES = 1024 * 1024;
const MAX_RECIPE_IMPORT_DEPTH = 32;
const RESERVED_AUTHORED_RECIPE_VALUE_NAMES = new Set([
    "recipe_dir",
    "skill_dir",
]);
export const RUNTIME_OWNED_RECIPE_INPUT_NAMES = Object.freeze([
    "owner_id",
    "recipe_dir",
    "run_instance_id",
    "runtime_state_root",
    "session_id",
    "skill_dir",
    "state_dir",
    "trace_file",
]);
const RUNTIME_OWNED_RECIPE_INPUT_SET = new Set(RUNTIME_OWNED_RECIPE_INPUT_NAMES);
export function isRuntimeOwnedRecipeInput(name) {
    return RUNTIME_OWNED_RECIPE_INPUT_SET.has(name);
}
export function createActiveSkillRecipeContext(skills) {
    const rootsByName = new Map();
    for (const skill of skills) {
        const name = skill.name.trim();
        const skillDir = skill.baseDir
            ? resolve(skill.baseDir)
            : skill.filePath
                ? dirname(resolve(skill.filePath))
                : undefined;
        if (!name || !skillDir)
            continue;
        const roots = rootsByName.get(name) ?? new Set();
        roots.add(resolve(skillDir, "recipes"));
        rootsByName.set(name, roots);
    }
    const namespaces = Object.fromEntries([...rootsByName.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, roots]) => [name, Object.freeze([...roots].sort())]));
    return Object.freeze({ namespaces: Object.freeze(namespaces) });
}
export const EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT = createActiveSkillRecipeContext([]);
export function getActiveSkillRecipeNamespaces(context) {
    return Object.fromEntries(Object.entries(context.namespaces).map(([name, roots]) => [
        name,
        [...roots],
    ]));
}
function nestedRecipeFiles(root) {
    if (!existsSync(root))
        return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            return nestedRecipeFiles(path);
        return entry.isFile() && /\.(?:json|md)$/u.test(entry.name) ? [path] : [];
    });
}
export function inventoryActiveSkillRecipeComponents(context) {
    const components = [];
    const rejected = [];
    for (const [skill, roots] of Object.entries(context.namespaces)) {
        if (roots.length > 1) {
            rejected.push({
                reason: `Duplicate active Skill identity ${skill} (${roots.length} active definitions); exact Recipe resolution is ambiguous. Next: inspect target=recipes view=doctor identity=${skill}/<recipe>`,
                skill,
            });
            continue;
        }
        const root = roots[0];
        if (!root || !existsSync(root))
            continue;
        const direct = readdirSync(root, { withFileTypes: true });
        for (const entry of direct.filter((candidate) => candidate.isDirectory())) {
            const nested = nestedRecipeFiles(join(root, entry.name));
            for (const file of nested) {
                rejected.push({
                    file,
                    reason: `Nested Skill Recipe file is not addressable: ${file}`,
                    skill,
                    stem: getRecipeIdFromPath(file),
                });
            }
        }
        const files = direct
            .filter((entry) => entry.isFile() && /\.(?:json|md)$/u.test(entry.name))
            .map((entry) => join(root, entry.name));
        const byStem = new Map();
        for (const file of files) {
            const stem = getRecipeIdFromPath(file);
            const matches = byStem.get(stem) ?? [];
            matches.push(file);
            byStem.set(stem, matches);
        }
        for (const [stem, matches] of [...byStem].sort(([a], [b]) => a.localeCompare(b))) {
            if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(stem)) {
                rejected.push({
                    file: matches[0],
                    reason: `Invalid Skill Recipe filename stem: ${stem}`,
                    skill,
                    stem,
                });
                continue;
            }
            if (matches.length > 1) {
                rejected.push({
                    file: matches[0],
                    reason: `Skill Recipe stem collision: ${skill}/${stem} has both .json and .md files`,
                    skill,
                    stem,
                });
                continue;
            }
            const file = matches[0];
            try {
                const raw = readRawRecipeConfig(file);
                if (!raw || !Object.hasOwn(raw, "template"))
                    throw new Error(`Invalid Skill Recipe component: ${skill}/${stem}`);
                assertRecipeHasNoDeclaredName(raw);
                components.push({
                    file,
                    identity: `${skill}/${stem}`,
                    imports: Object.fromEntries(Object.entries(getRecipeImports(raw)).map(([alias, value]) => [
                        alias,
                        getImportFrom(value),
                    ])),
                    skill,
                    stem,
                });
            }
            catch (error) {
                rejected.push({
                    file,
                    reason: error instanceof Error ? error.message : String(error),
                    skill,
                    stem,
                });
            }
        }
    }
    return { components, partial: rejected.length > 0, rejected };
}
export function listActiveSkillRecipeComponents(context) {
    const inventory = inventoryActiveSkillRecipeComponents(context);
    if (inventory.rejected.length > 0)
        throw new Error(inventory.rejected[0].reason);
    return inventory.components;
}
const SKILL_RECIPE_REFERENCE = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
function qualifiedRecipeNameForFile(file, context) {
    const path = resolve(file);
    for (const [skillName, roots] of Object.entries(context.namespaces)) {
        if (roots.length !== 1)
            continue;
        const root = roots[0];
        const relation = relative(root, path);
        if (relation &&
            dirname(relation) === "." &&
            !relation.startsWith("..") &&
            !isAbsolute(relation)) {
            return `${skillName}/${basename(relation, extname(relation))}`;
        }
    }
    return undefined;
}
function assertRecipeReferencePrefixWasNotRemoved(value) {
    if (value.startsWith("std:")) {
        throw new Error("std: Recipe references were removed in pi-actors 0.46. Use <skill>/<recipe> or an explicit .json/.md file path. Next: inspect target=recipes view=status to identify the active owning Skill.");
    }
    if (value.startsWith("skill:")) {
        const identity = value.slice("skill:".length);
        throw new Error(`skill: Recipe references were removed in pi-actors 0.46. Use ${identity} without a prefix. Next: inspect target=recipes view=doctor identity=${identity}`);
    }
}
function skillRecipeCandidates(value, context) {
    const match = SKILL_RECIPE_REFERENCE.exec(value);
    if (!match)
        return undefined;
    const [, skillName, recipeName] = match;
    const roots = [...(context.namespaces[skillName] ?? [])];
    if (roots.length === 0)
        throw new Error(`Active Skill Recipe not found: ${skillName}/${recipeName}. Owning Skill "${skillName}" is not active. Next: activate Skill ${skillName}, then inspect target=recipes view=doctor identity=${skillName}/${recipeName}`);
    if (roots.length > 1)
        throw new Error(`Duplicate active Skill identity ${skillName} (${roots.length} active definitions); ${skillName}/${recipeName} cannot resolve unambiguously. Next: inspect target=recipes view=doctor identity=${skillName}/${recipeName}`);
    const root = roots[0];
    const candidates = ["json", "md"].map((extension) => resolve(root, `${recipeName}.${extension}`));
    const existing = candidates.filter((candidate) => existsSync(candidate));
    if (existing.length === 0) {
        throw new Error(`Skill Recipe component not found: ${skillName}/${recipeName}; owning Skill "${skillName}" is active. Next: inspect target=recipes view=doctor identity=${skillName}/${recipeName}`);
    }
    if (existing.length > 1) {
        throw new Error(`Skill Recipe stem collision: ${skillName}/${recipeName} has both .json and .md files`);
    }
    return candidates;
}
function recipeReferenceCandidates(value, baseDir, context) {
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    assertRecipeReferencePrefixWasNotRemoved(trimmed);
    if (trimmed.endsWith(".json") || trimmed.endsWith(".md")) {
        return [resolve(baseDir, trimmed)];
    }
    return skillRecipeCandidates(trimmed, context);
}
function findOwningSkillDir(recipeFile) {
    let current = dirname(recipeFile);
    while (true) {
        if (existsSync(resolve(current, "SKILL.md")))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return undefined;
        current = parent;
    }
}
function assertRecipeHasNoDeclaredName(raw) {
    if (!Object.hasOwn(raw, "name"))
        return;
    throw new Error("Recipe.name was removed in pi-actors 0.46. File-backed Recipe identity is derived from its file name. Next: remove the name field, keep the intended filename stem, then inspect target=recipes view=doctor.");
}
function assertRuntimeRecipeValuesNotDeclared(raw) {
    const args = Array.isArray(raw.args)
        ? Schema.getExplicitToolArgNames(raw.args.map(String))
        : [];
    for (const name of RESERVED_AUTHORED_RECIPE_VALUE_NAMES) {
        if (args.includes(name) ||
            (isRecord(raw.defaults) && Object.hasOwn(raw.defaults, name)) ||
            (isRecord(raw.values) && Object.hasOwn(raw.values, name))) {
            throw new Error(`Recipe runtime value is reserved: ${name}`);
        }
    }
}
export function resolveRecipePath(value, baseDir = Paths.getRecipeRoot()) {
    const candidates = recipeReferenceCandidates(value, baseDir, EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT);
    if (!candidates || candidates.length !== 1) {
        throw new Error(`Recipe file reference must be an explicit .json or .md path: ${value}`);
    }
    return candidates[0];
}
function resolveRecipeImportPath(value, recipeDir, context) {
    const candidates = recipeReferenceCandidates(value, recipeDir, context);
    if (!candidates) {
        throw new Error(`Recipe import must use <skill>/<recipe> or an explicit .json/.md file path: ${value}`);
    }
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
export function resolveRecipeReferencePath(value, baseDir = Paths.getRecipeRoot(), context = EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT) {
    if (typeof value !== "string")
        return undefined;
    const candidates = recipeReferenceCandidates(value, baseDir, context);
    return candidates?.find((candidate) => existsSync(candidate));
}
export function getRecipePath(value, baseDir = Paths.getRecipeRoot(), context = EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT) {
    return resolveRecipeReferencePath(value, baseDir, context);
}
function isImportNode(value) {
    if (!isRecord(value) || Object.hasOwn(value, "template"))
        return false;
    return typeof value.name === "string";
}
function isValidRecipeTemplateNode(value) {
    if (isImportNode(value))
        return true;
    if (isRecord(value)) {
        if (isImportNode(value.template))
            return true;
        if (Array.isArray(value.template))
            return isValidRecipeTemplateArray(value.template);
    }
    return (CommandTemplates.expandCommandTemplateConfigs(value).length > 0);
}
function isValidRecipeTemplateArray(value) {
    return (value.length > 0 && value.every((item) => isValidRecipeTemplateNode(item)));
}
function normalizeRecipeTemplate(value) {
    if (typeof value === "string")
        return value.trim() || undefined;
    if (Array.isArray(value)) {
        const template = value;
        return isValidRecipeTemplateArray(template) ? template : undefined;
    }
    if (isImportNode(value))
        return value;
    if (value && typeof value === "object") {
        const template = value;
        if (Array.isArray(template.template) &&
            isValidRecipeTemplateArray(template.template))
            return template;
        if (isImportNode(template.template))
            return template;
        return CommandTemplates.expandCommandTemplateConfigs(template).length > 0
            ? template
            : undefined;
    }
    return undefined;
}
function getRecipeCommandTemplate(raw) {
    const template = raw.template;
    const envelope = {};
    for (const key of [
        "args",
        "defaults",
        "parallel",
        "concurrency",
        "min_successful",
        "label",
        "when",
        "timeout",
        "delay",
        "accept_output",
        "output",
        "retry",
        "failure",
        "recover",
        "repeat",
    ]) {
        if (raw[key] !== undefined)
            envelope[key] = raw[key];
    }
    if (Object.keys(envelope).length === 0)
        return normalizeRecipeTemplate(template);
    if (template && typeof template === "object" && !Array.isArray(template)) {
        return normalizeRecipeTemplate({
            ...envelope,
            ...template,
        });
    }
    return normalizeRecipeTemplate({ ...envelope, template });
}
function parseMarkdownScalar(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return trimmed;
        }
    }
    const quoted = trimmed.match(/^(?:"([^"]*)"|'([^']*)')$/);
    if (quoted)
        return quoted[1] ?? quoted[2] ?? "";
    if (trimmed === "true")
        return true;
    if (trimmed === "false")
        return false;
    if (trimmed === "null")
        return null;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed))
        return Number(trimmed);
    return trimmed;
}
function parseMarkdownFrontmatterObject(lines) {
    if (lines.every((line) => /^\s*-\s+/.test(line))) {
        return lines.map((line) => parseMarkdownScalar(line.replace(/^\s*-\s+/, "")));
    }
    const result = {};
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^\s{2}([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/);
        if (!match)
            continue;
        if (match[2]) {
            result[match[1]] = parseMarkdownScalar(match[2]);
            continue;
        }
        const nested = [];
        while (index + 1 < lines.length && /^\s{4}/.test(lines[index + 1])) {
            index += 1;
            nested.push(lines[index].slice(2));
        }
        result[match[1]] = parseMarkdownFrontmatterObject(nested);
    }
    return result;
}
function normalizeMarkdownFrontmatterField(key, value) {
    if (key === "args" && typeof value === "string") {
        return value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (key === "defaults" && Array.isArray(value)) {
        return Object.fromEntries(value
            .filter((item) => typeof item === "string")
            .map((item) => {
            const separator = item.indexOf(":");
            return separator < 0
                ? [item.trim(), ""]
                : [
                    item.slice(0, separator).trim(),
                    parseMarkdownScalar(item.slice(separator + 1)),
                ];
        })
            .filter(([name]) => Boolean(name)));
    }
    return value;
}
function parseMarkdownFrontmatter(value) {
    const result = {};
    const lines = value.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim() || line.trim().startsWith("#"))
            continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/);
        if (!match)
            continue;
        if (match[2]) {
            result[match[1]] = normalizeMarkdownFrontmatterField(match[1], parseMarkdownScalar(match[2]));
            continue;
        }
        const nested = [];
        while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
            index += 1;
            nested.push(lines[index]);
        }
        result[match[1]] = normalizeMarkdownFrontmatterField(match[1], parseMarkdownFrontmatterObject(nested));
    }
    return result;
}
function findMarkdownRecipeFence(body) {
    const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
    for (const match of body.matchAll(pattern)) {
        const info = match[1].trim().toLowerCase();
        if (info.includes("recipe") ||
            info.includes("template") ||
            info.includes("command") ||
            info.includes("json")) {
            return { info, body: match[2].trim() };
        }
    }
    return undefined;
}
function parseMarkdownRecipeConfig(content) {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---")
        return undefined;
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end === -1)
        return undefined;
    const frontmatter = parseMarkdownFrontmatter(lines.slice(1, end).join("\n"));
    const fence = findMarkdownRecipeFence(lines.slice(end + 1).join("\n"));
    if (!fence)
        return Object.hasOwn(frontmatter, "template") ? frontmatter : undefined;
    const text = fence.body.trim();
    if (!text)
        return undefined;
    if (fence.info.includes("json") ||
        fence.info.includes("recipe") ||
        text.startsWith("{") ||
        text.startsWith("[") ||
        text.startsWith('"')) {
        try {
            const parsed = JSON.parse(text);
            if (isRecord(parsed) && Object.hasOwn(parsed, "template"))
                return { ...frontmatter, ...parsed };
            return { ...frontmatter, template: parsed };
        }
        catch {
            if (fence.info.includes("json") || fence.info.includes("recipe"))
                return undefined;
        }
    }
    return { ...frontmatter, template: text };
}
export function diagnoseRawRecipeConfigFailure(path) {
    if (!existsSync(path))
        return "file does not exist";
    const size = statSync(path).size;
    if (size > MAX_RECIPE_FILE_BYTES) {
        return `file exceeds size limit ${MAX_RECIPE_FILE_BYTES} bytes`;
    }
    try {
        const content = readFileSync(path, "utf8");
        if (path.endsWith(".md")) {
            const lines = content.split(/\r?\n/);
            if (lines[0]?.trim() !== "---") {
                return "Markdown recipe must start with frontmatter";
            }
            const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
            if (end === -1)
                return "Markdown recipe frontmatter is not closed";
            const parsed = parseMarkdownRecipeConfig(content);
            if (!parsed)
                return "Markdown recipe has no executable recipe/template fence";
            if (!Object.hasOwn(parsed, "template"))
                return "recipe must define template";
            return undefined;
        }
        const raw = JSON.parse(content);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return "JSON recipe must be an object";
        }
        if (!Object.hasOwn(raw, "template"))
            return "recipe must define template";
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
export function readRawRecipeConfig(path) {
    if (!existsSync(path))
        return undefined;
    const size = statSync(path).size;
    if (size > MAX_RECIPE_FILE_BYTES) {
        throw new Error(`Recipe file exceeds size limit ${MAX_RECIPE_FILE_BYTES} bytes: ${path}`);
    }
    try {
        const content = readFileSync(path, "utf8");
        if (path.endsWith(".md"))
            return parseMarkdownRecipeConfig(content);
        const raw = JSON.parse(content);
        return raw && typeof raw === "object" ? raw : undefined;
    }
    catch {
        return undefined;
    }
}
export function getRecipeIdFromPath(file) {
    return basename(file, extname(file));
}
function readRecipeConfig(value) {
    const path = resolveRecipeReferencePath(value);
    return path ? readResolvedRecipeConfig(path) : undefined;
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function getRecipeImports(raw) {
    if (!isRecord(raw.imports))
        return {};
    const result = {};
    for (const [alias, value] of Object.entries(raw.imports)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(alias))
            throw new Error(`Invalid recipe import alias: ${alias}`);
        if (typeof value === "string") {
            result[alias] = value;
            continue;
        }
        if (!isRecord(value))
            throw new Error(`Recipe import must be a string or object: ${alias}`);
        const from = typeof value.from === "string" ? value.from.trim() : "";
        if (!from)
            throw new Error(`Recipe import must define from: ${alias}`);
        result[alias] = {
            from,
            ...(isRecord(value.defaults) ? { defaults: value.defaults } : {}),
            ...(isRecord(value.values) ? { values: value.values } : {}),
        };
    }
    return result;
}
function getImportFrom(value) {
    return typeof value === "string" ? value : (value.from ?? "");
}
function getPathValue(source, path) {
    if (!path)
        return source;
    let current = source;
    for (const key of path.split(".")) {
        if (!key)
            continue;
        if (!isRecord(current) || !Object.hasOwn(current, key))
            return undefined;
        current = current[key];
    }
    return current;
}
function resolveImportRef(ref, imports, allowMissing = false) {
    for (const [alias, imported] of Object.entries(imports)) {
        const prefix = `${alias}.`;
        if (!ref.startsWith(prefix))
            continue;
        const rest = ref.slice(prefix.length);
        const match = /^(name|file|defaults|values)(?:\.(.+))?$/.exec(rest);
        if (!match)
            return { matched: false, value: undefined };
        const section = match[1];
        if (section === "name")
            return { matched: true, value: imported.name };
        if (section === "file")
            return { matched: true, value: imported.file };
        const value = section === "defaults" ? imported.defaults : imported.values;
        const resolved = getPathValue(value, match[2]);
        if (resolved === undefined && !allowMissing)
            throw new Error(`Unknown recipe import reference: ${ref}`);
        return { matched: true, value: resolved };
    }
    return { matched: false, value: undefined };
}
function isFalsyImportValue(value) {
    return (value === undefined ||
        value === null ||
        value === false ||
        value === 0 ||
        value === "");
}
function parseImportLiteral(value, imports) {
    const trimmed = value.trim();
    const quoted = trimmed.match(/^(["'])(.*)\1$/);
    if (quoted)
        return quoted[2];
    const resolved = resolveImportRef(trimmed, imports, true);
    return resolved.matched ? resolved.value : trimmed;
}
function evaluateImportExpression(content, imports) {
    const trimmed = content.trim();
    const ternary = trimmed.match(/^(.+?)\?([^:]*):(.*)$/);
    if (ternary) {
        const condition = resolveImportRef(ternary[1].trim(), imports, true);
        if (!condition.matched)
            return { matched: false, value: undefined };
        return {
            matched: true,
            value: parseImportLiteral(isFalsyImportValue(condition.value) ? ternary[3] : ternary[2], imports),
        };
    }
    const fallback = trimmed.match(/^([^=]+)=(.*)$/);
    if (fallback) {
        const resolved = resolveImportRef(fallback[1].trim(), imports, true);
        if (!resolved.matched)
            return { matched: false, value: undefined };
        return {
            matched: true,
            value: resolved.value === undefined || resolved.value === null
                ? parseImportLiteral(fallback[2], imports)
                : resolved.value,
        };
    }
    return resolveImportRef(trimmed, imports);
}
function substituteImportRefs(value, imports) {
    if (typeof value === "string") {
        const exact = /^\{([^{}]+)\}$/.exec(value);
        if (exact) {
            const resolved = evaluateImportExpression(exact[1], imports);
            if (resolved.matched)
                return resolved.value;
        }
        return value.replaceAll(/\{([^{}]+)\}/g, (token, ref) => {
            const resolved = evaluateImportExpression(String(ref), imports);
            return resolved.matched ? String(resolved.value ?? "") : token;
        });
    }
    if (Array.isArray(value))
        return value.map((item) => substituteImportRefs(item, imports));
    if (isRecord(value)) {
        const result = {};
        for (const [key, child] of Object.entries(value))
            result[key] = substituteImportRefs(child, imports);
        return result;
    }
    return value;
}
function mergeDefaults(...items) {
    const merged = Object.assign({}, ...items.filter(Boolean));
    return Object.keys(merged).length > 0 ? merged : undefined;
}
function assertRecipeDefaultsDeclared(args, defaults, label) {
    const spec = Schema.parseToolArgDeclarationList(args ?? []);
    if (spec.error)
        throw new Error(spec.error);
    if (spec.args.length === 0)
        return;
    const declared = new Set(spec.args);
    for (const key of Object.keys(defaults ?? {})) {
        if (!declared.has(key))
            throw new Error(`Unknown ${label} argument: ${key}`);
    }
}
function assertRecipeArgumentContract(config, label = "Recipe default") {
    assertRecipeDefaultsDeclared(config.args, config.defaults, label);
    const spec = Schema.parseToolArgDeclarationList(config.args ?? []);
    if (spec.error)
        throw new Error(spec.error);
    Schema.assertCompatibleToolArgTypes(spec.argTypes, Schema.getTemplateArgTypes({ template: config.template }));
    const staticValues = Object.fromEntries(Object.entries({ ...config.defaults, ...config.values }).filter(([, value]) => typeof value !== "string" || !/\{[^{}]+\}/.test(value)));
    Schema.normalizeRuntimeValues(staticValues, spec.argTypes);
}
function resolveRecipeValueLayers(args, ...layers) {
    const spec = Schema.parseToolArgDeclarationList(args ?? []);
    if (spec.error)
        throw new Error(spec.error);
    const merged = mergeDefaults(spec.defaults, ...layers);
    if (!merged)
        return undefined;
    const staticValues = Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value !== "string" || !/\{[^{}]+\}/.test(value)));
    return {
        ...merged,
        ...Schema.normalizeRuntimeValues(staticValues, spec.argTypes),
    };
}
function applyDefaultsToTemplate(template, defaults, overrides) {
    const cleanOverrides = { ...overrides };
    delete cleanOverrides.name;
    delete cleanOverrides.template;
    delete cleanOverrides.values;
    delete cleanOverrides.defaults;
    if (typeof template === "object" && !Array.isArray(template)) {
        return {
            ...template,
            ...cleanOverrides,
            ...(mergeDefaults(template.defaults, defaults, isRecord(cleanOverrides.defaults) ? cleanOverrides.defaults : undefined)
                ? {
                    defaults: mergeDefaults(template.defaults, defaults, isRecord(cleanOverrides.defaults)
                        ? cleanOverrides.defaults
                        : undefined),
                }
                : {}),
        };
    }
    return {
        ...cleanOverrides,
        ...(defaults ? { defaults } : {}),
        template,
    };
}
function withActorRecipeContext(value, context) {
    if (typeof value === "object" && !Array.isArray(value)) {
        return { ...value, actorRecipeContext: context };
    }
    return { actorRecipeContext: context, template: value };
}
function loadDelegatedRecipe(value, currentRecipeFile, stack, options) {
    const path = resolveRecipeReferencePath(value, dirname(currentRecipeFile), options.skillContext);
    if (!path)
        return undefined;
    const config = readResolvedRecipeConfig(path, [...stack, currentRecipeFile], options);
    if (!config)
        throw new Error(`Template recipe must define template: ${path}`);
    if (config.disabled === true)
        throw new Error(`Template recipe is disabled: ${path}`);
    return config;
}
function applyDelegatedRecipeToNode(delegated, overrides = {}) {
    const nodeDefaults = isRecord(overrides.defaults)
        ? overrides.defaults
        : undefined;
    const nodeValues = isRecord(overrides.values) ? overrides.values : undefined;
    const values = resolveRecipeValueLayers(delegated.args, delegated.defaults, delegated.values, nodeDefaults, nodeValues, {
        ...(delegated.recipe_dir ? { recipe_dir: delegated.recipe_dir } : {}),
        ...(delegated.skill_dir ? { skill_dir: delegated.skill_dir } : {}),
    });
    return applyDefaultsToTemplate(delegated.template, values, overrides);
}
function expandRecipeDelegations(value, currentRecipeFile, stack, options = {}) {
    if (typeof value === "string") {
        const delegated = loadDelegatedRecipe(value, currentRecipeFile, stack, options);
        return delegated ? applyDelegatedRecipeToNode(delegated) : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => expandRecipeDelegations(item, currentRecipeFile, stack, options));
    }
    const record = value;
    if (typeof record.template === "string") {
        const delegated = loadDelegatedRecipe(record.template, currentRecipeFile, stack, options);
        if (delegated)
            return applyDelegatedRecipeToNode(delegated, record);
    }
    if (Array.isArray(record.template)) {
        return {
            ...record,
            template: record.template.map((item) => expandRecipeDelegations(item, currentRecipeFile, stack, options)),
        };
    }
    if (record.template && typeof record.template === "object") {
        return {
            ...record,
            template: expandRecipeDelegations(record.template, currentRecipeFile, stack, options),
        };
    }
    return value;
}
function getDirectDelegatedRecipe(value, currentRecipeFile, stack, options = {}) {
    if (typeof value === "string")
        return loadDelegatedRecipe(value, currentRecipeFile, stack, options);
    if (!Array.isArray(value) && typeof value.template === "string") {
        return loadDelegatedRecipe(value.template, currentRecipeFile, stack, options);
    }
    return undefined;
}
function resolveDirectDelegationArgs(delegated, wrapperArgs, wrapperDefaults) {
    if (!Array.isArray(delegated.args))
        return Array.isArray(wrapperArgs) ? wrapperArgs.map(String) : undefined;
    const delegatedSpec = Schema.parseToolArgDeclarationList(delegated.args);
    if (delegatedSpec.error)
        throw new Error(delegatedSpec.error);
    const wrapperDeclarations = Array.isArray(wrapperArgs)
        ? wrapperArgs.map(String)
        : [];
    const wrapperSpec = Schema.parseToolArgDeclarationList(wrapperDeclarations);
    if (wrapperSpec.error)
        throw new Error(wrapperSpec.error);
    const declared = new Set(delegatedSpec.args);
    for (const arg of wrapperSpec.args) {
        if (!declared.has(arg))
            throw new Error(`Unknown delegated Recipe argument: ${arg}`);
    }
    Schema.assertCompatibleToolArgTypes(delegatedSpec.argTypes, wrapperSpec.argTypes);
    assertRecipeDefaultsDeclared(delegated.args, wrapperDefaults, "delegated Recipe default");
    Schema.normalizeRuntimeValues(Object.fromEntries(Object.entries(wrapperDefaults ?? {}).filter(([, value]) => typeof value !== "string" || !/\{[^{}]+\}/.test(value))), delegatedSpec.argTypes);
    return delegated.args;
}
function expandImportNodes(value, imports, options = {}) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value.map((item) => expandImportNodes(item, imports, options));
    }
    const record = value;
    const importAlias = !Object.hasOwn(record, "template") && typeof record.name === "string"
        ? record.name
        : undefined;
    if (importAlias) {
        const imported = imports[importAlias];
        if (!imported)
            throw new Error(`Unknown recipe import: ${importAlias}`);
        const nodeDefaults = isRecord(record.defaults)
            ? record.defaults
            : undefined;
        const nodeValues = isRecord(record.values) ? record.values : undefined;
        const defaults = resolveRecipeValueLayers(imported.config.args, imported.defaults, imported.values, nodeDefaults, nodeValues);
        const expanded = applyDefaultsToTemplate(imported.config.template, defaults, record);
        return options.includeActorRecipeContext
            ? withActorRecipeContext(expanded, {
                alias: imported.alias,
                file: imported.file,
                name: imported.name,
                path: imported.alias,
                role: "import",
            })
            : expanded;
    }
    if (Array.isArray(record.template)) {
        return {
            ...record,
            template: record.template.map((item) => expandImportNodes(item, imports, options)),
        };
    }
    if (record.template && typeof record.template === "object") {
        return {
            ...record,
            template: expandImportNodes(record.template, imports, options),
        };
    }
    return value;
}
export function readResolvedRecipeConfig(file, stack = [], options = {}) {
    const path = resolveRecipePath(file, stack.length > 0 ? dirname(stack.at(-1)) : Paths.getRecipeRoot());
    if (stack.includes(path)) {
        throw new Error(`Cyclic recipe import: ${[...stack, path].join(" -> ")}`);
    }
    if (stack.length >= MAX_RECIPE_IMPORT_DEPTH) {
        throw new Error(`Recipe import depth exceeds limit ${MAX_RECIPE_IMPORT_DEPTH}: ${[...stack, path].join(" -> ")}`);
    }
    const raw = options.authoredEntry?.path === path
        ? options.authoredEntry.recipe
        : readRawRecipeConfig(path);
    if (!raw || !Object.hasOwn(raw, "template"))
        return undefined;
    assertRecipeHasNoDeclaredName(raw);
    RecipeControl.assertRecipeHasNoMailbox(raw);
    assertRuntimeRecipeValuesNotDeclared(raw);
    assertRecipeArgumentContract(raw);
    const imports = {};
    for (const [alias, binding] of Object.entries(getRecipeImports(raw))) {
        const importPath = resolveRecipeImportPath(getImportFrom(binding), dirname(path), options.skillContext ?? EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT);
        const config = readResolvedRecipeConfig(importPath, [...stack, path], options);
        if (!config)
            throw new Error(`Recipe import not found: ${alias}`);
        const bindingDefaults = typeof binding === "string" ? undefined : binding.defaults;
        const bindingValues = typeof binding === "string" ? undefined : binding.values;
        assertRecipeDefaultsDeclared(config.args, bindingDefaults, `Recipe import ${alias} default`);
        imports[alias] = {
            alias,
            file: importPath,
            name: getRecipeIdFromPath(importPath),
            config,
            defaults: { ...(config.defaults ?? {}), ...(bindingDefaults ?? {}) },
            values: {
                ...(bindingValues ?? {}),
                ...(config.recipe_dir ? { recipe_dir: config.recipe_dir } : {}),
                ...(config.skill_dir ? { skill_dir: config.skill_dir } : {}),
            },
        };
    }
    const substituted = substituteImportRefs(raw, imports);
    const template = getRecipeCommandTemplate(substituted);
    if (!template)
        return undefined;
    const expandedImportsTemplate = expandImportNodes(template, imports, options);
    const delegated = getDirectDelegatedRecipe(expandedImportsTemplate, path, stack, options);
    const expandedTemplate = delegated
        ? applyDelegatedRecipeToNode(delegated, typeof expandedImportsTemplate === "object" &&
            !Array.isArray(expandedImportsTemplate)
            ? expandedImportsTemplate
            : {})
        : expandRecipeDelegations(expandedImportsTemplate, path, stack, options);
    const recipeName = getRecipeIdFromPath(path);
    const recipeDir = dirname(path);
    const skillDir = findOwningSkillDir(path);
    if (!skillDir &&
        JSON.stringify({
            artifacts: substituted.artifacts,
            defaults: substituted.defaults,
            template: substituted.template,
            values: substituted.values,
        }).includes("{skill_dir}")) {
        throw new Error(`Recipe uses {skill_dir} outside an owning Skill directory: ${path}`);
    }
    const templateWithContext = options.includeActorRecipeContext
        ? withActorRecipeContext(expandedTemplate, {
            file: path,
            name: recipeName,
            path: recipeName,
            role: stack.length > 0 ? "import" : "entry",
        })
        : expandedTemplate;
    const wrapperDefaults = isRecord(substituted.defaults)
        ? substituted.defaults
        : undefined;
    const mergedDefaults = mergeDefaults(delegated?.defaults, wrapperDefaults);
    const effectiveArgs = delegated
        ? resolveDirectDelegationArgs(delegated, substituted.args, wrapperDefaults)
        : Array.isArray(substituted.args)
            ? substituted.args
            : undefined;
    const artifactSource = isRecord(substituted.artifacts)
        ? substituted.artifacts
        : delegated?.artifacts;
    const control = RecipeControl.normalizeRecipeControl(Object.hasOwn(substituted, "control")
        ? substituted.control
        : delegated?.control);
    return {
        name: recipeName,
        recipe_dir: recipeDir,
        ...(skillDir ? { skill_dir: skillDir } : {}),
        ...(typeof substituted.description === "string" &&
            substituted.description.trim()
            ? { description: substituted.description.trim() }
            : typeof delegated?.description === "string"
                ? { description: delegated.description }
                : {}),
        ...(typeof substituted.disabled === "boolean"
            ? { disabled: substituted.disabled }
            : typeof delegated?.disabled === "boolean"
                ? { disabled: delegated.disabled }
                : {}),
        ...(substituted.async === true
            ? { async: true }
            : substituted.async === false
                ? { async: false }
                : delegated?.async === true
                    ? { async: true }
                    : delegated?.async === false
                        ? { async: false }
                        : {}),
        ...(substituted.singleton === true || delegated?.singleton === true
            ? {
                singleton: true,
                singleton_run_id: delegated?.singleton === true
                    ? delegated.singleton_run_id
                    : skillDir
                        ? basename(skillDir)
                        : undefined,
                singleton_recipe_id: delegated?.singleton === true
                    ? delegated.singleton_recipe_id
                    : skillDir
                        ? `${basename(skillDir)}/${recipeName}`
                        : undefined,
            }
            : {}),
        ...(Object.keys(imports).length > 0
            ? { imports: getRecipeImports(raw) }
            : {}),
        template: templateWithContext,
        ...(effectiveArgs ? { args: effectiveArgs } : {}),
        ...(mergedDefaults ? { defaults: mergedDefaults } : {}),
        ...(typeof substituted.parallel === "boolean"
            ? { parallel: substituted.parallel }
            : {}),
        ...(typeof substituted.concurrency === "number" ||
            typeof substituted.concurrency === "string"
            ? { concurrency: substituted.concurrency }
            : {}),
        ...(typeof substituted.min_successful === "number" ||
            typeof substituted.min_successful === "string"
            ? { min_successful: substituted.min_successful }
            : {}),
        ...(typeof substituted.label === "string"
            ? { label: substituted.label }
            : {}),
        ...(typeof substituted.when === "string" ||
            typeof substituted.when === "boolean"
            ? { when: substituted.when }
            : {}),
        ...(typeof substituted.timeout === "number" ||
            typeof substituted.timeout === "string"
            ? { timeout: substituted.timeout }
            : {}),
        ...(typeof substituted.delay === "number" ||
            typeof substituted.delay === "string"
            ? { delay: substituted.delay }
            : {}),
        ...(substituted.accept_output === "review_evidence"
            ? { accept_output: substituted.accept_output }
            : {}),
        ...(typeof substituted.output === "string"
            ? { output: substituted.output }
            : {}),
        ...(isRecord(artifactSource)
            ? {
                artifacts: Object.fromEntries(Object.entries(artifactSource).filter((entry) => typeof entry[1] === "string")),
            }
            : {}),
        ...(control !== undefined ? { control } : {}),
        ...(substituted.retire_when === "children_terminal" ||
            delegated?.retire_when === "children_terminal"
            ? { retire_when: "children_terminal" }
            : {}),
        ...(typeof substituted.retry === "number" ||
            typeof substituted.retry === "string"
            ? { retry: substituted.retry }
            : {}),
        ...(substituted.failure === "continue" ||
            substituted.failure === "branch" ||
            substituted.failure === "root"
            ? { failure: substituted.failure }
            : {}),
        ...(substituted.recover !== undefined
            ? { recover: substituted.recover }
            : {}),
        ...(typeof substituted.repeat === "number"
            ? { repeat: substituted.repeat }
            : {}),
        values: {
            ...(isRecord(substituted.values) ? substituted.values : {}),
            recipe_dir: recipeDir,
            ...(skillDir ? { skill_dir: skillDir } : {}),
        },
        ...(isRecord(substituted.usage) ? { usage: substituted.usage } : {}),
    };
}
function collectRecipeContextRecords(file, stack, importPath, context, alias) {
    const path = resolveRecipePath(file, stack.length > 0 ? dirname(stack.at(-1)) : Paths.getRecipeRoot());
    if (stack.includes(path)) {
        throw new Error(`Cyclic recipe import: ${[...stack, path].join(" -> ")}`);
    }
    if (stack.length >= MAX_RECIPE_IMPORT_DEPTH) {
        throw new Error(`Recipe import depth exceeds limit ${MAX_RECIPE_IMPORT_DEPTH}: ${[...stack, path].join(" -> ")}`);
    }
    const raw = readRawRecipeConfig(path);
    if (!raw || !Object.hasOwn(raw, "template"))
        return [];
    assertRecipeHasNoDeclaredName(raw);
    const qualifiedName = qualifiedRecipeNameForFile(path, context);
    const skill = qualifiedName?.split("/", 1)[0];
    const record = {
        ...(alias ? { alias } : {}),
        depth: stack.length,
        import_path: importPath,
        logical_reference: qualifiedName ?? basename(path),
        name: getRecipeIdFromPath(path),
        recipe: raw,
        role: stack.length === 0 ? "entry" : "import",
        ...(skill ? { skill } : {}),
        source_file: path,
        source_kind: qualifiedName
            ? "active_skill_component"
            : "explicit_file_recipe",
    };
    const imports = getRecipeImports(raw);
    const children = Object.entries(imports).flatMap(([childAlias, binding]) => {
        const importFile = resolveRecipeImportPath(getImportFrom(binding), dirname(path), context);
        return collectRecipeContextRecords(importFile, [...stack, path], [...importPath, childAlias], context, childAlias);
    });
    return [record, ...children];
}
export function buildRecipeContextRecords(file, context = EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT) {
    return collectRecipeContextRecords(file, [], [], context);
}
export function getRecipeTemplate(value) {
    return readRecipeConfig(value)?.template;
}
export function isRecipeReference(value) {
    return getRecipePath(value) !== undefined;
}
export function isAsyncRecipeReference(value) {
    return readRecipeConfig(value)?.async === true;
}
export function isRecipeTool(template, recipe) {
    return recipe !== undefined || isRecipeReference(template);
}
