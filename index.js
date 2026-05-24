/**
 * Runtime extension entrypoint wrapper.
 *
 * Installed npm packages load compiled JS from dist so Node does not try to strip
 * TypeScript under node_modules. Source checkouts fall back to index.ts for local
 * development before dist has been built.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const compiledEntry = resolve(here, "dist", "index.js");
const sourceEntry = resolve(here, "index.ts");
const entry = existsSync(compiledEntry) ? compiledEntry : sourceEntry;
const entryModule = await import(pathToFileURL(entry).href);

export default entryModule.default;
