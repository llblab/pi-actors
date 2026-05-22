#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

function usage() {
  console.error(`Usage:
  recipe-utils.mjs run-summary <state-root>
  recipe-utils.mjs run-ops-snapshot <state-root> <run-id> [lines] [stale-minutes]
  recipe-utils.mjs playlist <source-dir> [extensions] [max-depth] [paths|m3u|inline]
  recipe-utils.mjs changelog-section <file> <version>
  recipe-utils.mjs artifact-manifest <artifact-path> <title> <status> [summary]
  recipe-utils.mjs artifact-write <artifact-path> [create|overwrite|append]
  recipe-utils.mjs actor-message <type> [to] [from] [summary] [metadata-json] [correlation-id] [reply-to]
  recipe-utils.mjs package-summary <package-json>
  recipe-utils.mjs skill-summary <skill-md> [package-json]`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const ADDRESS_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MESSAGE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
function assertToken(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`${label} is required`);
  if (!ADDRESS_PATTERN.test(normalized))
    fail(`${label} contains unsupported characters: ${value}`);
  return normalized;
}

function validateActorAddress(address, label) {
  const value = String(address ?? "").trim();
  if (value === "coordinator") return value;
  const separator = value.indexOf(":");
  if (separator < 0) fail(`${label} must include an actor kind: ${address}`);
  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1);
  if (kind === "branch") {
    const [run, branch, ...extra] = rest.split("/");
    if (extra.length > 0)
      fail(`${label} branch address has too many parts: ${address}`);
    return `branch:${assertToken(run, `${label} branch run`)}/${assertToken(branch, `${label} branch id`)}`;
  }
  if (["run", "session", "tool"].includes(kind))
    return `${kind}:${assertToken(rest, label)}`;
  fail(`${label} has unsupported actor kind: ${kind}`);
}

function validateMessageType(type) {
  const value = String(type ?? "").trim();
  if (!MESSAGE_TYPE_PATTERN.test(value))
    fail(`Invalid actor message type: ${type}`);
  return value;
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

function collectRunSummary(rootValue) {
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
      updated:
        progress?.updatedAt ??
        result?.completedAt ??
        run.updated_at ??
        run.completed_at ??
        run.started_at ??
        "",
    });
  }
  rows.sort((a, b) =>
    `${a.status}:${a.run}`.localeCompare(`${b.status}:${b.run}`),
  );
  return rows;
}

function runSummary(rootValue) {
  console.log(JSON.stringify(collectRunSummary(rootValue), null, 2));
}

function tailJsonl(fileValue, linesValue = "80") {
  const file = resolve(
    fileValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  if (!existsSync(file)) return [];
  const lines = Number.parseInt(linesValue, 10);
  const count = Number.isFinite(lines) && lines > 0 ? lines : 80;
  return readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

function runOpsSnapshot(
  rootValue,
  runIdValue = "music",
  linesValue = "80",
  staleMinutesValue = "60",
) {
  const runs = collectRunSummary(rootValue);
  const root = resolve(
    rootValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const inspectedRun = String(runIdValue || "music");
  const messageFile = join(root, inspectedRun, "outbox.jsonl");
  const staleMs = Number(staleMinutesValue) * 60 * 1000;
  const now = Date.now();
  const recommendations = runs.flatMap((run) => {
    const updatedMs = Date.parse(run.updated || "");
    const stale =
      Number.isFinite(updatedMs) &&
      Number.isFinite(staleMs) &&
      now - updatedMs > staleMs;
    if (run.status === "running" && stale) {
      return [
        {
          run: run.run,
          reason: "running-stale",
          suggested_message: {
            to: `run:${run.run}`,
            type: "control.stop",
            body: "stop",
          },
        },
      ];
    }
    if (["failed", "exited", "killed"].includes(run.status)) {
      return [
        {
          run: run.run,
          reason: `terminal-${run.status}`,
          suggested_inspect: { target: `run:${run.run}`, view: "tail" },
        },
      ];
    }
    return [];
  });
  console.log(
    JSON.stringify(
      {
        runs,
        inspectedRun,
        messages: tailJsonl(messageFile, linesValue),
        recommendations,
      },
      null,
      2,
    ),
  );
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

function artifactManifest(
  pathValue,
  title = "Artifact",
  status = "draft",
  summary = "",
) {
  const path = resolve(
    pathValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const exists = existsSync(path);
  const stat = exists ? statSync(path) : undefined;
  console.log(
    JSON.stringify(
      {
        title,
        status,
        path,
        exists,
        bytes: stat?.size ?? 0,
        modified: stat?.mtime?.toISOString?.() ?? null,
        summary,
      },
      null,
      2,
    ),
  );
}

function artifactWrite(pathValue, mode = "create") {
  const path = resolve(
    pathValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  if (!["create", "overwrite", "append"].includes(mode)) {
    fail(`Invalid artifact write mode: ${mode}`);
  }
  if (mode === "create" && existsSync(path)) {
    fail(`Artifact already exists: ${path}`);
  }
  const content = readFileSync(0, "utf8");
  mkdirSync(dirname(path), { recursive: true });
  if (mode === "append") appendFileSync(path, content);
  else writeFileSync(path, content, "utf8");
  const stat = statSync(path);
  console.log(
    JSON.stringify({ path, mode, bytes: stat.size, written: true }, null, 2),
  );
}

function actorMessage(
  type = "event",
  to = "coordinator",
  from = "run:{run_id}",
  summary = "",
  metadataValue = "",
  correlationId = "",
  replyTo = "",
) {
  const messageType = validateMessageType(type);
  const messageTo = validateActorAddress(to, "message.to");
  const messageFrom = validateActorAddress(from, "message.from");
  let metadata = {};
  if (metadataValue) {
    try {
      const parsed = JSON.parse(metadataValue);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        metadata = parsed;
      else fail("Actor message metadata must be a JSON object");
    } catch (error) {
      fail(`Invalid actor message metadata JSON: ${error.message}`);
    }
  }
  const bodyText = readFileSync(0, "utf8");
  const trimmed = bodyText.trim();
  let body = bodyText;
  if (trimmed) {
    try {
      body = JSON.parse(trimmed);
    } catch {
      body = bodyText;
    }
  }
  console.log(
    JSON.stringify(
      {
        to: messageTo,
        from: messageFrom,
        type: messageType,
        summary: summary || messageType,
        body,
        ...(correlationId ? { correlation_id: correlationId } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        metadata,
      },
      null,
      2,
    ),
  );
}

function packageSummary(fileValue = "package.json") {
  const file = resolve(
    fileValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const pkg = readJson(file);
  if (!pkg) fail(`Package JSON not found or invalid: ${fileValue}`);
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object"
      ? Object.keys(pkg.scripts).sort()
      : [];
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === "object"
      ? Object.keys(pkg.dependencies).sort()
      : [];
  const devDependencies =
    pkg.devDependencies && typeof pkg.devDependencies === "object"
      ? Object.keys(pkg.devDependencies).sort()
      : [];
  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
}

function parseSkillFrontmatter(content) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const fields = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return { frontmatter, fields };
}

function skillSummary(skillValue, packageValue = "package.json") {
  const skillFile = resolve(
    skillValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const packageFile = resolve(
    packageValue.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
  );
  const content = readFileSync(skillFile, "utf8");
  const pkg = readJson(packageFile) ?? {};
  const { frontmatter, fields } = parseSkillFrontmatter(content);
  const scalarLines = frontmatter
    .split(/\r?\n/)
    .filter((line) => /^\w+:\s*\S/.test(line));
  const extraColonLines = scalarLines.filter(
    (line) => (line.match(/:/g) ?? []).length > 1,
  );
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const version =
    fields.version ??
    frontmatter.match(/^\s+version:\s*([^\n]+)\s*$/m)?.[1]?.trim() ??
    "";
  console.log(
    JSON.stringify(
      {
        path: skillValue,
        name: fields.name ?? "",
        description: fields.description ?? "",
        version,
        packageVersion: pkg.version ?? "",
        versionMatchesPackage: version === pkg.version,
        frontmatterExtraColonLines: extraColonLines,
        bodyLineCount: body.split(/\r?\n/).length,
        headings: body.split(/\r?\n/).filter((line) => /^#{1,6}\s/.test(line)),
      },
      null,
      2,
    ),
  );
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
  runSummary(args[0] ?? "~/.pi/agent/tmp/pi-actors/runs");
else if (command === "run-ops-snapshot")
  runOpsSnapshot(
    args[0] ?? "~/.pi/agent/tmp/pi-actors/runs",
    args[1] ?? "music",
    args[2],
    args[3],
  );
else if (command === "playlist")
  playlist(args[0] ?? "~/Music", args[1], args[2], args[3]);
else if (command === "changelog-section")
  changelogSection(args[0] ?? "CHANGELOG.md", args[1] ?? "Unreleased");
else if (command === "artifact-manifest")
  artifactManifest(args[0] ?? "artifact.md", args[1], args[2], args[3]);
else if (command === "artifact-write")
  artifactWrite(args[0] ?? "artifact.md", args[1] ?? "create");
else if (command === "actor-message")
  actorMessage(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
else if (command === "package-summary")
  packageSummary(args[0] ?? "package.json");
else if (command === "skill-summary")
  skillSummary(args[0] ?? "skills/actors/SKILL.md", args[1] ?? "package.json");
else {
  usage();
  fail(`Unknown command: ${command}`);
}
