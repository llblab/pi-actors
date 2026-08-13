#!/usr/bin/env node
/**
 * pi-actors Domain DAG validator.
 * Owns local import-graph and composition-root diagnostics for agent-led architecture work.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const DEFAULTS = {
  sourceRoots: ["index.ts", "lib"],
  entrypoints: ["index.ts"],
  sourceExtensions: [".ts", ".js", ".mjs"],
  excludePatterns: ["**/*.test.ts", "**/*.d.ts"],
  requireHeaders: false,
  headerSeverity: "warn",
  sharedBucketSeverity: "warn",
  forbiddenEdges: [],
};
const SHARED_NAMES = new Set(["common", "constants", "helpers", "shared", "types", "utils"]);

function parseArgs(argv) {
  const args = { root: ".", config: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[++index];
    else if (arg === "--config") args.config = argv[++index];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function globPattern(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    if (glob.slice(index, index + 3) === "**/") {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.slice(index, index + 2) === "**") {
      pattern += ".*";
      index += 1;
    } else if (glob[index] === "*") pattern += "[^/]*";
    else if (glob[index] === "?") pattern += "[^/]";
    else pattern += glob[index].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`);
}

function matches(path, patterns = []) {
  return patterns.some((pattern) => globPattern(pattern).test(toPosix(path)));
}

function collectFiles(root, config) {
  const files = new Set();
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() && [".git", "dist", "node_modules"].includes(entry.name)) continue;
        visit(join(path, entry.name));
      }
      return;
    }
    const name = toPosix(relative(root, path));
    if (config.sourceExtensions.includes(extname(path)) && !matches(name, config.excludePatterns))
      files.add(resolve(path));
  };
  for (const sourceRoot of config.sourceRoots) {
    const path = resolve(root, sourceRoot);
    if (existsSync(path)) visit(path);
  }
  return [...files].sort();
}

function imports(source) {
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n\r]*/gm, "$1");
  const found = new Set();
  for (const pattern of [
    /(?:import|export)\s+(?:type\s+)?[^"']*?\s+from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) for (const match of clean.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function resolveImport(file, specifier, fileSet, extensions) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))])
    if (fileSet.has(candidate)) return candidate;
  return undefined;
}

function buildGraph(root, files, config) {
  const fileSet = new Set(files);
  return new Map(files.map((file) => {
    const dependencies = imports(readFileSync(file, "utf8"))
      .map((specifier) => resolveImport(file, specifier, fileSet, config.sourceExtensions))
      .filter(Boolean)
      .map((path) => toPosix(relative(root, path)));
    return [toPosix(relative(root, file)), [...new Set(dependencies)].sort()];
  }));
}

function findCycles(graph) {
  const cycles = [];
  const complete = new Set();
  const active = [];
  const visit = (node) => {
    const offset = active.indexOf(node);
    if (offset >= 0) {
      cycles.push([...active.slice(offset), node]);
      return;
    }
    if (complete.has(node)) return;
    active.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    active.pop();
    complete.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return cycles;
}

function validate(root, config) {
  const files = collectFiles(root, config);
  const graph = buildGraph(root, files, config);
  const errors = [];
  const warnings = [];
  for (const cycle of findCycles(graph)) errors.push(`Import cycle: ${cycle.join(" -> ")}`);
  const entrypoints = new Set(config.entrypoints.map(toPosix));
  for (const [file, dependencies] of graph) {
    if (entrypoints.has(file)) continue;
    for (const dependency of dependencies)
      if (entrypoints.has(dependency)) errors.push(`Domain module imports composition root: ${file} -> ${dependency}`);
  }
  for (const edge of config.forbiddenEdges ?? []) {
    const from = globPattern(edge.from);
    const to = globPattern(edge.to);
    for (const [file, dependencies] of graph)
      for (const dependency of dependencies)
        if (from.test(file) && to.test(dependency)) (edge.severity === "warn" ? warnings : errors).push(edge.message ?? `Forbidden edge: ${file} -> ${dependency}`);
  }
  const header = /\b(?:Domain|Domains|Owns|Zone|Zones):\s*\S/im;
  if (config.requireHeaders)
    for (const file of files)
      if (!header.test(readFileSync(file, "utf8").slice(0, 1600)))
        (config.headerSeverity === "error" ? errors : warnings).push(`Missing domain header: ${toPosix(relative(root, file))}`);
  for (const file of files) {
    const path = toPosix(relative(root, file));
    const parts = path.split("/");
    if (parts.some((part) => SHARED_NAMES.has(part.replace(/\.[^.]+$/, ""))))
      (config.sharedBucketSeverity === "error" ? errors : warnings).push(`Shared-bucket candidate: ${path}`);
  }
  return { ok: errors.length === 0, files: files.length, edges: [...graph.values()].reduce((sum, value) => sum + value.length, 0), errors, warnings };
}

function printHelp() {
  console.log("Usage: validate-domain-dag.mjs [--root <path>] [--config <path>] [--json]");
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const root = resolve(args.root);
  const configPath = args.config ? resolve(root, args.config) : undefined;
  const config = { ...DEFAULTS, ...(configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {}) };
  const report = validate(root, config);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("--- DOMAIN DAG VALIDATOR ---\n");
    console.log(`[INFO] ${report.files} source files, ${report.edges} local import edges`);
    for (const warning of report.warnings) console.log(`[WARN] ${warning}`);
    for (const error of report.errors) console.log(`[FAIL] ${error}`);
    if (report.ok) console.log("[PASS] Local import graph and composition-root direction are valid");
    console.log(`\nResult: ${report.errors.length} error(s), ${report.warnings.length} warning(s)`);
  }
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
