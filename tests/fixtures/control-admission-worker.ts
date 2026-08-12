import { appendRunControlInStateDir } from "../../lib/runs-controls.ts";

const stateDir = process.argv[2]!;
const worker = Number(process.argv[3]);
try {
  const record = appendRunControlInStateDir(stateDir, {
    action: "pause",
    input: { worker },
    run_instance_id: "generation-a",
  });
  process.stdout.write(`${record.id}\n`);
} catch (error) {
  const value = error as Record<string, unknown>;
  process.stderr.write(`${String(value.reason ?? (error as Error).message)}\n`);
  process.exitCode = 2;
}
