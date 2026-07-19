#!/usr/bin/env node
/** Reproducible exact-tree, Domain DAG, secret-hygiene, and ABCd release gates. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "pi-actors-release-index-"));
const indexPath = join(temp, "index");
const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
const failures = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "no output").trim()}`,
    );
  }
  return result.stdout;
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function stagedText(path) {
  const result = spawnSync("git", ["show", `:${path}`], {
    cwd: root,
    env: gitEnv,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`could not read staged file: ${path}`);
    return undefined;
  }
  const bytes = result.stdout;
  if (bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

function sourceImports(source) {
  return [...source.matchAll(/^import(?:\s+type)?\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["'];?$/gmu)]
    .map((match) => match[1]);
}

function resolveLocalImport(from, specifier, sourceSet) {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalize(join(dirname(from), specifier)).replaceAll("\\", "/");
  const candidates = extname(base)
    ? [base.replace(/\.js$/u, ".ts")]
    : [`${base}.ts`, `${base}/index.ts`];
  return candidates.find((candidate) => sourceSet.has(candidate));
}

try {
  run("git", ["read-tree", "HEAD"], { env: gitEnv });
  run("git", ["add", "-A"], { env: gitEnv });
  run("git", ["diff", "--cached", "--check"], { env: gitEnv });
  const files = run("git", ["ls-files", "-z"], { env: gitEnv })
    .split("\0")
    .filter(Boolean);
  const fileSet = new Set(files);
  console.log(`[release] exact temporary index: ${files.length} files`);

  const secretPatterns = [
    [/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]{80,}?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/u, "private-key block"],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u, "AWS access key"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b/u, "GitHub token"],
    [/\bglpat-[A-Za-z0-9_-]{20,}\b|\bnpm_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, "service token"],
  ];
  const publicPath = /^(?:README\.md|AGENTS\.md|BACKLOG\.md|CHANGELOG\.md|docs\/|skills\/|recipes\/)/u;
  for (const path of files) {
    const text = stagedText(path);
    if (text === undefined) continue;
    if (!path.startsWith("tests/") && !path.startsWith("fixtures/")) {
      for (const [pattern, label] of secretPatterns) {
        check(!pattern.test(text), `${label} detected in ${path}`);
      }
    }
    if (publicPath.test(path)) {
      check(!/(?:^|[\s"'`])\/home\/[A-Za-z0-9._-]+\//u.test(text), `machine-local path in ${path}`);
    }
  }
  console.log("[release] bounded secret and public-path hygiene checked");

  const sources = files.filter((path) => path === "index.ts" || (path.startsWith("lib/") && path.endsWith(".ts")));
  const sourceSet = new Set(sources);
  const graph = new Map();
  for (const path of sources) {
    const text = stagedText(path) ?? "";
    const headerEnd = text.indexOf("*/");
    const header = headerEnd >= 0 ? text.slice(0, headerEnd + 2) : "";
    check(
      header.startsWith("/**") && (header.includes("Zones:") || header.includes("Owns:")),
      `missing domain header: ${path}`,
    );
    const edges = sourceImports(text)
      .map((specifier) => resolveLocalImport(path, specifier, sourceSet))
      .filter(Boolean);
    graph.set(path, edges);
    if (path.startsWith("lib/")) {
      check(!edges.includes("index.ts"), `domain imports entrypoint: ${path}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(path, stack = []) {
    if (visiting.has(path)) {
      failures.push(`Domain DAG cycle: ${[...stack, path].join(" -> ")}`);
      return;
    }
    if (visited.has(path)) return;
    visiting.add(path);
    for (const next of graph.get(path) ?? []) visit(next, [...stack, path]);
    visiting.delete(path);
    visited.add(path);
  }
  for (const path of sources) visit(path);
  console.log(`[release] strict Domain DAG: ${sources.length} sources, acyclic`);

  for (const path of ["README.md", "AGENTS.md", "BACKLOG.md", "CHANGELOG.md", "docs/README.md"]) {
    check(fileSet.has(path), `missing ABCd root/context file: ${path}`);
  }
  const readStaged = (path) => stagedText(path) ?? "";
  const readme = readStaged("README.md");
  for (const path of ["AGENTS.md", "BACKLOG.md", "CHANGELOG.md", "docs/README.md"]) {
    check(readme.includes(path), `README.md does not route to ${path}`);
  }
  for (const path of files.filter((candidate) => candidate.endsWith(".md"))) {
    const text = readStaged(path);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/u.test(target)) continue;
      const resolved = normalize(join(dirname(path), decodeURIComponent(target))).replaceAll("\\", "/");
      check(fileSet.has(resolved), `broken Markdown link: ${path} -> ${target}`);
    }
  }
  const docsIndex = readStaged("docs/README.md");
  for (const path of files.filter((candidate) => candidate.startsWith("docs/") && candidate.endsWith(".md") && candidate !== "docs/README.md")) {
    check(docsIndex.includes(relative("docs", path).replaceAll("\\", "/")), `docs/README.md omits ${path}`);
  }
  console.log("[release] ABCd context roots, routing, and Markdown links checked");

  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("[release] all supplemental release gates passed");
  }
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
