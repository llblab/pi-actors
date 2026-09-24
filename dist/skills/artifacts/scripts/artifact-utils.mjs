#!/usr/bin/env node

/** Artifact-owned deterministic manifest and write helpers. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function pathOf(value) {
  return resolve(String(value).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
}

function manifest(pathValue, title = "Artifact", status = "draft", summary = "") {
  const path = pathOf(pathValue);
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

function write(pathValue, mode = "create") {
  const path = pathOf(pathValue);
  if (!["create", "overwrite", "append"].includes(mode))
    fail(`Invalid artifact write mode: ${mode}`);
  if (mode === "create" && existsSync(path)) fail(`Artifact already exists: ${path}`);
  const content = readFileSync(0, "utf8");
  mkdirSync(dirname(path), { recursive: true });
  if (mode === "append") appendFileSync(path, content);
  else writeFileSync(path, content, "utf8");
  console.log(JSON.stringify({
    path,
    mode,
    bytes: statSync(path).size,
    written: true,
  }, null, 2));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "manifest") manifest(args[0] ?? "artifact.md", args[1], args[2], args[3]);
  else if (command === "write") write(args[0] ?? "artifact.md", args[1]);
  else fail(`Unknown artifact command: ${command ?? ""}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
