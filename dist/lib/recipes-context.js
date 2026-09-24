/**
 * Recipe context contracts and prompt assembly.
 * Zones: live session resolution, async runner prompt context, recipe provenance, LLM child launches
 * Owns the immutable live Recipe environment and compact actor context appended to child-agent prompts.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import * as RecipesReferences from "./recipes-references.js";
export function createRecipeResolutionContext(sessionId, cwd, activeSkills) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId)
        throw new Error("Recipe resolution session id is required.");
    const normalizedCwd = resolve(cwd);
    const generation = createHash("sha256")
        .update(JSON.stringify({
        activeSkills: RecipesReferences.getActiveSkillRecipeNamespaces(activeSkills),
        cwd: normalizedCwd,
        sessionId: normalizedSessionId,
    }))
        .digest("hex");
    return Object.freeze({
        activeSkills,
        cwd: normalizedCwd,
        generation,
        sessionId: normalizedSessionId,
    });
}
export function createEmptyRecipeResolutionContext(sessionId, cwd) {
    return createRecipeResolutionContext(sessionId, cwd, RecipesReferences.EMPTY_ACTIVE_SKILL_RECIPE_CONTEXT);
}
function commandName(command) {
    return basename(command).toLowerCase();
}
function isPiCommand(command) {
    return commandName(command) === "pi";
}
const PI_PRINT_FLAGS = new Set(["-p", "--print"]);
const PI_VALUE_OPTIONS = new Set([
    "--api-key",
    "--append-system-prompt",
    "--exclude-tools",
    "--extension",
    "--fork",
    "--mode",
    "--model",
    "--models",
    "--name",
    "--prompt-template",
    "--provider",
    "--session",
    "--session-dir",
    "--skill",
    "--system-prompt",
    "--theme",
    "--thinking",
    "--tools",
]);
const PI_SHORT_VALUE_OPTIONS = new Set(["-e", "-n", "-t", "-xt"]);
function isPiPrintFlag(arg) {
    return PI_PRINT_FLAGS.has(arg);
}
function isPiOption(arg) {
    return arg.startsWith("-") && arg !== "-";
}
function piOptionConsumesNextArg(arg) {
    if (arg.includes("="))
        return false;
    return PI_VALUE_OPTIONS.has(arg) || PI_SHORT_VALUE_OPTIONS.has(arg);
}
function isPiFileArgument(arg) {
    return arg.startsWith("@") && arg.length > 1;
}
function findPiPrintPromptIndexes(args) {
    let printMode = false;
    let positionalOnly = false;
    const promptIndexes = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!positionalOnly && arg === "--") {
            positionalOnly = true;
            continue;
        }
        if (!positionalOnly && isPiPrintFlag(arg)) {
            printMode = true;
            continue;
        }
        if (!positionalOnly && isPiOption(arg)) {
            if (piOptionConsumesNextArg(arg))
                index += 1;
            continue;
        }
        if (!printMode || isPiFileArgument(arg))
            continue;
        promptIndexes.push(index);
    }
    return promptIndexes;
}
export function findPiPrintPromptIndex(args) {
    return findPiPrintPromptIndexes(args).at(-1);
}
function matchesActorContext(record, context) {
    if (!context)
        return record.role === "entry";
    if (context.file && context.file === record.source_file)
        return true;
    if (context.name && context.name === record.name)
        return true;
    if (context.alias && context.alias === record.alias)
        return true;
    return false;
}
function contextPath(record, context) {
    return record.import_path.join(".") || context?.path || record.name;
}
export function markRecipeContextRecords(records, context) {
    let marked = false;
    const result = records.map((record) => {
        if (marked || !matchesActorContext(record, context))
            return record;
        marked = true;
        return {
            ...record,
            you_are_here: true,
            you_are_here_path: contextPath(record, context),
        };
    });
    return result;
}
export function formatRecipeContextJsonl(records, context) {
    return markRecipeContextRecords(records, context)
        .map(({ source_file: _sourceFile, ...record }) => JSON.stringify(record))
        .join("\n");
}
export function buildRecipeContextPromptBlock(records, context) {
    const jsonl = formatRecipeContextJsonl(records, context);
    if (!jsonl)
        return "";
    return [
        "Actor recipe context bundle follows as JSONL.",
        'Each line is one recipe/context record; `"you_are_here": true` marks the recipe node that launched this actor.',
        "Use this as workflow/composition context, while the task prompt remains authoritative.",
        "```jsonl",
        jsonl,
        "```",
    ].join("\n");
}
export function appendRecipeContextToPiArgs(command, args, records, context) {
    if (!records || records.length === 0 || !isPiCommand(command))
        return args;
    const promptIndex = findPiPrintPromptIndex(args);
    if (promptIndex === undefined)
        return args;
    const block = buildRecipeContextPromptBlock(records, context);
    if (!block)
        return args;
    const next = [...args];
    next[promptIndex] = `${next[promptIndex]}\n\n${block}`;
    return next;
}
const PI_SESSION_POLICY_FLAGS = new Set([
    "--fork",
    "--no-session",
    "--session",
    "--session-dir",
    "--session-id",
]);
export function attachPiSessionDir(command, args, sessionDir) {
    if (!isPiCommand(command) || findPiPrintPromptIndex(args) === undefined) {
        return { args };
    }
    if (args.some((arg) => PI_SESSION_POLICY_FLAGS.has(arg)))
        return { args };
    return { args: ["--session-dir", sessionDir, ...args], sessionDir };
}
export function materializePiPrintPromptArg(command, args, promptFile) {
    if (!isPiCommand(command))
        return { args };
    const promptIndexes = findPiPrintPromptIndexes(args);
    if (promptIndexes.length === 0)
        return { args };
    const prompt = promptIndexes.map((index) => args[index]).join(" ");
    const path = typeof promptFile === "function" ? promptFile() : promptFile;
    writeFileSync(path, prompt, "utf8");
    const promptIndexSet = new Set(promptIndexes);
    const firstPromptIndex = promptIndexes[0];
    const next = args.flatMap((arg, index) => {
        if (index === firstPromptIndex)
            return [`@${path}`];
        return promptIndexSet.has(index) ? [] : [arg];
    });
    return {
        args: next,
        promptBytes: Buffer.byteLength(prompt),
        promptFile: path,
    };
}
