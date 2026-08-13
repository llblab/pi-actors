#!/usr/bin/env node

/** Media-owned playlist construction helper. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

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

function playlist(
  sourceValue,
  extensionsValue = ".mp3,.ogg,.wav,.flac,.m4a",
  maxDepthValue = "2",
  outputMode = "paths",
) {
  const source = resolve(String(sourceValue).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const maxDepth = Number.parseInt(maxDepthValue, 10);
  const extensions = new Set(extensionsValue.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  const files = walkFiles(source, Number.isFinite(maxDepth) ? maxDepth : 2)
    .filter((file) => extensions.has(extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  if (outputMode === "m3u") console.log(["#EXTM3U", ...files].join("\n"));
  else if (outputMode === "inline") console.log(files.join("|"));
  else console.log(files.join("\n"));
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "playlist") playlist(args[0] ?? "~/Music", args[1], args[2], args[3]);
  else fail(`Unknown media command: ${command ?? ""}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
