#!/usr/bin/env -S node --experimental-strip-types
import { cpSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function scriptFile() {
  return fileURLToPath(import.meta.url);
}

function isUnderNodeModules(file) {
  return /[/\\]node_modules[/\\]/.test(file);
}

function prepareTypeStripImportRoot() {
  const packageRoot = dirname(dirname(scriptFile()));
  const sourceLib = join(packageRoot, "lib");
  if (!isUnderNodeModules(packageRoot)) return sourceLib;
  const copiedLib = join(mkdtempSync(join(tmpdir(), "pi-actors-validate-lib-")), "lib");
  cpSync(sourceLib, copiedLib, { recursive: true });
  return copiedLib;
}

const typeStripImportRoot = prepareTypeStripImportRoot();
const { readResolvedRecipeConfig } = await import(
  pathToFileURL(join(typeStripImportRoot, "recipe-references.ts")).href
);

function usage() {
  console.error(`Usage:
  validate-recipe.mjs <recipe-file-or-dir> [--all]

Validates one template recipe file, or all *.json files in a directory when --all is set.`);
}

function expandPath(value) {
  return resolve(
    String(value).replace(/^~(?=\/|$)/, process.env.HOME ?? homedir()),
  );
}

function templateKind(template) {
  if (typeof template === "string") return "leaf";
  if (Array.isArray(template)) return "sequence";
  if (template && typeof template === "object") {
    if (typeof template.template === "string") return "leaf";
    if (Array.isArray(template.template))
      return template.parallel === true ? "parallel" : "sequence";
    if (template.parallel === true) return "parallel";
    return "object";
  }
  return "unknown";
}

function recipeFiles(target, all) {
  if (!existsSync(target)) throw new Error(`Recipe path not found: ${target}`);
  const stat = statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory())
    throw new Error(`Recipe path is not a file or directory: ${target}`);
  if (!all) throw new Error("Directory validation requires --all.");
  return readdirSync(target)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => resolve(target, file));
}

function validateFile(file) {
  try {
    const config = readResolvedRecipeConfig(file);
    if (!config?.template)
      throw new Error("Recipe must define a non-empty template.");
    return {
      file,
      ok: true,
      name: config.name ?? "",
      async: Boolean(config.async),
      args: Array.isArray(config.args) ? config.args : [],
      defaults:
        config.defaults && typeof config.defaults === "object"
          ? Object.keys(config.defaults).sort()
          : [],
      imports:
        config.imports && typeof config.imports === "object"
          ? Object.keys(config.imports).sort()
          : [],
      mailbox:
        config.mailbox && typeof config.mailbox === "object"
          ? {
              accepts: Array.isArray(config.mailbox.accepts)
                ? config.mailbox.accepts
                : [],
              emits: Array.isArray(config.mailbox.emits)
                ? config.mailbox.emits
                : [],
            }
          : undefined,
      template: templateKind(config.template),
    };
  } catch (error) {
    return {
      file,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const args = process.argv.slice(2);
const targetArg = args.find((arg) => !arg.startsWith("-"));
const all = args.includes("--all");
if (!targetArg || args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(targetArg ? 0 : 1);
}

const files = recipeFiles(expandPath(targetArg), all);
const results = files.map(validateFile);
const failed = results.filter((result) => !result.ok).length;
const report = {
  ok: failed === 0,
  total: results.length,
  passed: results.length - failed,
  failed,
  results,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
