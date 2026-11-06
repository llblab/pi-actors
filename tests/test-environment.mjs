import fs, { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test-runner process gets a fresh default agent directory, never an operator-supplied path.
// Retain it: test-runner exit alone does not prove that every inherited Run process has exited.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-actors-test-agent-"));

/** Observe actual removal of one lock: Windows unlinks directly, POSIX renames before unlinking. */
export function afterMutationLockRelease(lock, callback) {
  const rename = fs.renameSync, remove = fs.rmSync, renamed = new Set();
  let fired = false;
  fs.renameSync = (from, to) => {
    const result = rename(from, to);
    if (String(from) === lock) renamed.add(String(to));
    return result;
  };
  fs.rmSync = (...args) => {
    const result = Reflect.apply(remove, fs, args), path = String(args[0]);
    if (!fired && (path === lock || renamed.has(path))) { fired = true; callback(); }
    return result;
  };
  syncBuiltinESMExports();
  return () => { fs.renameSync = rename; fs.rmSync = remove; syncBuiltinESMExports(); };
}
