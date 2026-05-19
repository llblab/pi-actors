#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

function usage() {
  console.error(`Usage:
  recipe-utils.mjs run-summary <state-root>
  recipe-utils.mjs playlist <source-dir> [extensions] [max-depth] [paths|m3u|inline]
  recipe-utils.mjs changelog-section <file> <version>
  recipe-utils.mjs artifact-manifest <artifact-path> <title> <status> [summary]
  recipe-utils.mjs package-summary <package-json>`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function walkFiles(dir, maxDepth = 2, depth = 0, out = []) {
  if (depth > maxDepth || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, maxDepth, depth + 1, out);
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function getRunStatus(run, progress, result) {
  if (progress?.phase) return progress.phase;
  if (result?.code !== undefined) return result.code === 0 ? "done" : "failed";
  return run.status ?? "unknown";
}

function runSummary(rootValue) {
  const root = resolve(
    rootValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const files = walkFiles(root, 2).filter((file) => file.endsWith("/run.json"));
  const rows = [];
  for (const file of files) {
    const run = readJson(file);
    if (!run) {
      rows.push({
        run: relative(root, file),
        status: "invalid-json",
        recipe: "",
        updated: "",
      });
      continue;
    }
    const runDir = dirname(file);
    const progress = readJson(join(runDir, "progress.json"));
    const result = readJson(join(runDir, "result.json"));
    rows.push({
      run: run.run_id ?? run.run ?? relative(root, file).split("/")[0],
      status: getRunStatus(run, progress, result),
      recipe: run.recipe ?? run.recipe_file ?? "",
      updated: progress?.updatedAt ?? result?.completedAt ?? run.updated_at ?? run.completed_at ?? run.started_at ?? "",
    });
  }
  rows.sort((a, b) =>
    `${a.status}:${a.run}`.localeCompare(`${b.status}:${b.run}`),
  );
  console.log(JSON.stringify(rows, null, 2));
}

function playlist(
  sourceValue,
  extensionsValue = ".mp3,.ogg,.wav,.flac,.m4a",
  maxDepthValue = "2",
  outputMode = "paths",
) {
  const source = resolve(
    sourceValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const maxDepth = Number.parseInt(maxDepthValue, 10);
  const extensions = new Set(
    extensionsValue
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const files = walkFiles(source, Number.isFinite(maxDepth) ? maxDepth : 2)
    .filter((file) => extensions.has(extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  if (outputMode === "m3u") console.log(["#EXTM3U", ...files].join("\n"));
  else if (outputMode === "inline") console.log(files.join("|"));
  else console.log(files.join("\n"));
}

function artifactManifest(pathValue, title = "Artifact", status = "draft", summary = "") {
  const path = resolve(pathValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const exists = existsSync(path);
  const stat = exists ? statSync(path) : undefined;
  console.log(JSON.stringify({
    title,
    status,
    path,
    exists,
    bytes: stat?.size ?? 0,
    modified: stat?.mtime?.toISOString?.() ?? null,
    summary,
  }, null, 2));
}

function packageSummary(fileValue = "package.json") {
  const file = resolve(fileValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const pkg = readJson(file);
  if (!pkg) fail(`Package JSON not found or invalid: ${fileValue}`);
  const scripts = pkg.scripts && typeof pkg.scripts === "object"
    ? Object.keys(pkg.scripts).sort()
    : [];
  const dependencies = pkg.dependencies && typeof pkg.dependencies === "object"
    ? Object.keys(pkg.dependencies).sort()
    : [];
  const devDependencies = pkg.devDependencies && typeof pkg.devDependencies === "object"
    ? Object.keys(pkg.devDependencies).sort()
    : [];
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
    scripts,
    dependencyCount: dependencies.length,
    devDependencyCount: devDependencies.length,
    dependencies,
    devDependencies,
  }, null, 2));
}

function changelogSection(fileValue, version) {
  const file = resolve(fileValue);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.startsWith("## ") && line.includes(version),
  );
  if (start < 0) fail(`Version section not found: ${version}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  console.log(lines.slice(start, end).join("\n").trimEnd());
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  usage();
  process.exit(1);
}

if (command === "run-summary")
  runSummary(args[0] ?? "~/.pi/agent/tmp/pi-auto-tools/runs");
else if (command === "playlist")
  playlist(args[0] ?? "~/Music", args[1], args[2], args[3]);
else if (command === "changelog-section")
  changelogSection(args[0] ?? "CHANGELOG.md", args[1] ?? "Unreleased");
else if (command === "artifact-manifest")
  artifactManifest(args[0] ?? "artifact.md", args[1], args[2], args[3]);
else if (command === "package-summary")
  packageSummary(args[0] ?? "package.json");
else {
  usage();
  fail(`Unknown command: ${command}`);
}
