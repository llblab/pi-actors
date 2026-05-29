#!/usr/bin/env node

/**
 * Template recipe validator CLI.
 *
 * Owns CLI parsing and report formatting directly. Recipe parsing remains in
 * the reusable recipe-reference domain.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function importRuntimeModule(name) {
  const root = packageRoot();
  const compiled = join(root, "dist", "lib", `${name}.js`);
  const source = join(root, "lib", `${name}.ts`);
  return await import(pathToFileURL(existsSync(compiled) ? compiled : source).href);
}

const { readResolvedRecipeConfig } = await importRuntimeModule("recipes-references");

export function validateRecipeUsage() {
  return `Usage:
  validate-recipe.mjs <recipe-file-or-dir> [--all]

Validates one template recipe file, or all *.json/*.md files in a directory when --all is set.`;
}

function expandPath(value) {
  return resolve(String(value).replace(/^~(?=\/|$)/, process.env.HOME ?? homedir()));
}

function templateKind(template) {
  if (typeof template === "string") return "leaf";
  if (Array.isArray(template)) return "sequence";
  if (template && typeof template === "object") {
    const node = template;
    if (typeof node.template === "string") return "leaf";
    if (Array.isArray(node.template))
      return node.parallel === true ? "parallel" : "sequence";
    if (node.parallel === true) return "parallel";
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
    .filter((file) => file.endsWith(".json") || file.endsWith(".md"))
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

export function validateRecipes(argv) {
  const targetArg = argv.find((arg) => !arg.startsWith("-"));
  const all = argv.includes("--all");
  if (!targetArg || argv.includes("--help") || argv.includes("-h")) {
    return { help: true, ok: Boolean(targetArg), usage: validateRecipeUsage() };
  }

  const files = recipeFiles(expandPath(targetArg), all);
  const results = files.map(validateFile);
  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0,
    total: results.length,
    passed: results.length - failed,
    failed,
    results,
  };
}

try {
  const report = validateRecipes(process.argv.slice(2));
  if (report.help) console.error(report.usage);
  else console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
