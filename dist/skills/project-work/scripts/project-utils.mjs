#!/usr/bin/env node

/** Project-work metadata and changelog helpers. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pathOf(value) {
  return resolve(String(value).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function packageSummary(fileValue = "package.json") {
  const pkg = readJson(pathOf(fileValue));
  if (!pkg) fail(`Package JSON not found or invalid: ${fileValue}`);
  const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
  const devDependencies = Object.keys(pkg.devDependencies ?? {}).sort();
  console.log(JSON.stringify({
    name: pkg.name ?? "",
    version: pkg.version ?? "",
    type: pkg.type ?? "",
    private: Boolean(pkg.private),
    packageManager: pkg.packageManager ?? "",
    files: Array.isArray(pkg.files) ? pkg.files : [],
    bin: pkg.bin ?? null,
    main: pkg.main ?? "",
    exports: pkg.exports ?? null,
    scripts: Object.keys(pkg.scripts ?? {}).sort(),
    dependencyCount: dependencies.length,
    devDependencyCount: devDependencies.length,
    dependencies,
    devDependencies,
  }, null, 2));
}

function skillSummary(skillValue, packageValue = "package.json") {
  const content = readFileSync(pathOf(skillValue), "utf8");
  const pkg = readJson(pathOf(packageValue)) ?? {};
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const fields = Object.fromEntries(frontmatter.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    return match ? [[match[1], match[2].trim()]] : [];
  }));
  const version = fields.version ?? frontmatter.match(/^\s+version:\s*([^\n]+)$/m)?.[1]?.trim() ?? "";
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  console.log(JSON.stringify({
    path: skillValue,
    name: fields.name ?? "",
    description: fields.description ?? "",
    version,
    packageVersion: pkg.version ?? "",
    versionMatchesPackage: version === pkg.version,
    frontmatterExtraColonLines: frontmatter.split(/\r?\n/).filter((line) =>
      /^\w+:\s*\S/.test(line) && (line.match(/:/g) ?? []).length > 1),
    bodyLineCount: body.split(/\r?\n/).length,
    headings: body.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line)),
  }, null, 2));
}

function changelogSection(fileValue, version) {
  const lines = readFileSync(pathOf(fileValue), "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("## ") && line.includes(version));
  if (start < 0) fail(`Version section not found: ${version}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  console.log(lines.slice(start, next < 0 ? lines.length : next).join("\n").trimEnd());
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "package-summary") packageSummary(args[0]);
  else if (command === "skill-summary") skillSummary(args[0], args[1]);
  else if (command === "changelog-section") changelogSection(args[0] ?? "CHANGELOG.md", args[1] ?? "Unreleased");
  else fail(`Unknown project command: ${command ?? ""}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
