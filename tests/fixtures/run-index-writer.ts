import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const frame = { ...input.frame, pid: process.pid, host_exit: "not_asserted", workloads: 0 };
fs.writeFileSync(input.manifest, `${JSON.stringify(frame)}\n`);
const index = await import("../../lib/runs-index.ts");
const state = await import("../../lib/file-state.ts");
const lock = state.mutationLockPath(join(input.catalog, "index.json"));
const rename = fs.renameSync;
fs.renameSync = ((from, to) => {
  if (String(to) === lock && fs.existsSync(lock)) fs.writeFileSync(input.blocked, "blocked\n");
  return rename(from, to);
}) as typeof fs.renameSync;
syncBuiltinESMExports();
fs.writeFileSync(input.ready, "ready\n");
while (!fs.existsSync(input.go)) await new Promise(resolve => setTimeout(resolve, 10));
if (input.mode === "register") index.registerRunStateDirectory(input.catalog, input.status.state_dir, input.status);
else index.rebuildRunStateIndex(input.catalog, path => {
  if (path !== input.status.state_dir) throw new Error("Controlled partial maintenance observation");
  return input.status;
});
process.stdout.write(`${JSON.stringify({ kind: "catalog-writer-settled", frame })}\n`);
