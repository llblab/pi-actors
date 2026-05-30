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
  validate-recipe.mjs <recipe-file-or-dir> [--all] [--qa] [--summary]

Validates one template recipe file, or all *.json/*.md files in a directory when --all is set. Add --qa for packaged-recipe quality checks. Add --summary for compact CLI output.`;
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

function mailboxType(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.type === "string")
    return value.type;
  return undefined;
}

function collectTemplateStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectTemplateStrings(item, out));
  else if (value && typeof value === "object") {
    collectTemplateStrings(value.template, out);
    collectTemplateStrings(value.recover, out);
  }
  return out;
}

function hasPlatformNote(config) {
  const text = [
    config.description,
    config.platforms,
    config.platform_notes,
    config.requirements,
  ]
    .filter(Boolean)
    .join(" ");
  return /linux|macos|darwin|windows|win32|unix|wsl|cross-platform|portable/i.test(text);
}

function validateArtifactDeclarations(config) {
  const diagnostics = [];
  const artifacts = config.artifacts;
  if (artifacts === undefined) return diagnostics;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    diagnostics.push("artifacts: must be an object of named artifact paths");
    return diagnostics;
  }
  for (const [name, value] of Object.entries(artifacts)) {
    const path = typeof value === "string" ? value : value?.path;
    if (typeof path !== "string" || !path.trim())
      diagnostics.push(`artifacts.${name}: must declare a non-empty path`);
    if (typeof path === "string" && /^\/home\//.test(path))
      diagnostics.push(`artifacts.${name}: must not use a machine-local absolute path`);
  }
  return diagnostics;
}

function validateHelperPaths(file, config) {
  const diagnostics = [];
  for (const template of collectTemplateStrings(config.template)) {
    if (/(^|\s)(?:node\s+)?scripts\/[\w.-]+\.mjs/.test(template))
      diagnostics.push("template: helper scripts must be referenced through {repo}/scripts for installed packages");
    for (const match of template.matchAll(/\{repo\}\/scripts\/([^\s"']+\.mjs)/g)) {
      const scriptPath = join(packageRoot(), "scripts", match[1]);
      if (!existsSync(scriptPath))
        diagnostics.push(`template: referenced helper script not found: scripts/${match[1]}`);
    }
  }
  return diagnostics;
}

function validateMailboxContract(file, config) {
  const diagnostics = [];
  const mailbox = config.mailbox;
  const accepts = Array.isArray(mailbox?.accepts) ? mailbox.accepts : [];
  const emits = Array.isArray(mailbox?.emits) ? mailbox.emits : [];
  if (config.async === true && !mailbox)
    diagnostics.push("mailbox: async recipes must declare mailbox metadata");
  if (config.async === true && !accepts.map(mailboxType).includes("control.kill"))
    diagnostics.push("mailbox.accepts: async recipes must include control.kill");
  const allowedLegacyTypes = new Set(["awaiting_assignment"]);
  for (const [key, entries] of Object.entries({ accepts, emits })) {
    entries.forEach((entry, index) => {
      const type = mailboxType(entry);
      if (!type) diagnostics.push(`mailbox.${key}[${index}]: must be a string or object with type`);
      else if (
        !allowedLegacyTypes.has(type) &&
        !/^[a-z][a-z0-9_-]*\.(?:[a-z][a-z0-9_-]*|\*)$/.test(type)
      )
        diagnostics.push(`mailbox.${key}[${index}]: message type must use channel.action form`);
    });
  }
  const allowedDomainTermination = new Set([
    "coordinator-locker.json",
    "locker.json",
    "music-player.json",
  ]);
  const hasDomainTermination = accepts
    .map(mailboxType)
    .some((type) => type === "control.stop" || type === "control.cancel");
  if (hasDomainTermination && !allowedDomainTermination.has(file.split(/[\\/]/).pop()))
    diagnostics.push("mailbox.accepts: control.stop/control.cancel are reserved for actor-domain handlers");
  return diagnostics;
}

function qaDiagnostics(file, config) {
  const diagnostics = [];
  const warnings = [];
  if (typeof config.description !== "string" || !config.description.trim())
    warnings.push("description: missing or empty");
  diagnostics.push(...validateMailboxContract(file, config));
  diagnostics.push(...validateArtifactDeclarations(config));
  diagnostics.push(...validateHelperPaths(file, config));
  const platformSpecificTemplate = collectTemplateStrings(config.template).some(
    (template) =>
      /(^|\s)(?:systemctl|launchctl|osascript|powershell|pwsh|cmd\.exe|apt|apt-get|dnf|yum|brew|pacman|apk)(\s|$)/i.test(
        template,
      ),
  );
  if (platformSpecificTemplate && !hasPlatformNote(config))
    diagnostics.push("platform: platform-specific templates must document platform scope");
  return { diagnostics, warnings };
}

function qaOk(qaReport) {
  return qaReport.diagnostics.length === 0;
}

function validateFile(file, qa = false) {
  try {
    const config = readResolvedRecipeConfig(file);
    if (!config?.template)
      throw new Error("Recipe must define a non-empty template.");
    const qaReport = qa ? qaDiagnostics(file, config) : { diagnostics: [], warnings: [] };
    return {
      file,
      ok: qaOk(qaReport),
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
      ...(qa
        ? {
            qa: {
              ok: qaOk(qaReport),
              diagnostics: qaReport.diagnostics,
              warnings: qaReport.warnings,
            },
          }
        : {}),
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
  const qa = argv.includes("--qa");
  if (!targetArg || argv.includes("--help") || argv.includes("-h")) {
    return { help: true, ok: Boolean(targetArg), usage: validateRecipeUsage() };
  }

  const files = recipeFiles(expandPath(targetArg), all);
  const results = files.map((file) => validateFile(file, qa));
  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0,
    total: results.length,
    passed: results.length - failed,
    failed,
    results,
  };
}

function summarizeReport(report) {
  const results = Array.isArray(report.results) ? report.results : [];
  return {
    ok: report.ok,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    diagnostics: results.reduce(
      (total, result) => total + (result.qa?.diagnostics?.length ?? 0),
      0,
    ),
    warnings: results.reduce(
      (total, result) => total + (result.qa?.warnings?.length ?? 0),
      0,
    ),
    failed_files: results
      .filter((result) => !result.ok)
      .map((result) => ({
        file: result.file,
        ...(result.error ? { error: result.error } : {}),
        ...(result.qa?.diagnostics?.length
          ? { diagnostics: result.qa.diagnostics }
          : {}),
      })),
  };
}

try {
  const argv = process.argv.slice(2);
  const report = validateRecipes(argv);
  if (report.help) console.error(report.usage);
  else console.log(JSON.stringify(argv.includes("--summary") ? summarizeReport(report) : report, null, 2));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
