import { appendRunTraceEvent } from "../../lib/runs-trace.ts";

const stateDir = process.argv[2]!;
const worker = Number(process.argv[3]);
const count = Number(process.argv[4]);

for (let index = 0; index < count; index += 1) {
  appendRunTraceEvent(stateDir, {
    data: { index, worker },
    kind: "stress.append",
    summary: `worker ${worker} event ${index}`,
  });
}
