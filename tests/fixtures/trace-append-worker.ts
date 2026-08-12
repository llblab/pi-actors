import { appendRunTraceEvent } from "../../lib/runs-trace.ts";

const stateDir = process.argv[2]!;
const worker = Number(process.argv[3]);
const count = Number(process.argv[4]);
const payload = "x".repeat(Number(process.argv[5] ?? 0));

for (let index = 0; index < count; index += 1) {
  appendRunTraceEvent(stateDir, {
    data: { index, payload, worker },
    kind: "stress.append",
    summary: `worker ${worker} event ${index}`,
  });
}
