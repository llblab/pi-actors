/**
 * Review-swarm dogfood fixture
 * Exercises the packaged review pipeline through the detached async runner with a fake local pi executable.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getRunStatus, startRun } from "../lib/async-runs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${path}`);
}

function fakePiScript(): string {
  return [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    "",
    "const args = process.argv.slice(2);",
    'let prompt = args.join(" ");',
    "for (const arg of args) {",
    '  if (arg.startsWith("@")) {',
    '    prompt += "\\n" + readFileSync(arg.slice(1), "utf8");',
    "  }",
    "}",
    'const stdin = readFileSync(0, "utf8");',
    "const full = `${prompt}\\n${stdin}`;",
    'const task = full.split("Actor recipe context bundle follows")[0];',
    "",
    'if (task.includes("Preflight check for stage")) {',
    '  console.log("ACTOR_PREFLIGHT_OK fake provider ready");',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Review fixture-scope through this lens")) {',
    '  const lens = task.match(/lens: ([^\\n.]+)/)?.[1]?.trim() ?? "unknown";',
    '  if (lens === "security") {',
    '    console.error("reviewer security simulated provider failure");',
    "    process.exit(7);",
    "  }",
    '  console.log(`REVIEW ${lens}: evidence for fixture-scope`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Verify this claim")) {',
    '  console.log(`VERIFICATION: usable reviewer evidence confirmed\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Merge these subagent outputs")) {',
    '  console.log(`MERGED: preserved partial reviewer evidence\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Judge this merged review")) {',
    '  console.log(`JUDGE: degraded confidence accepted\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Normalize this subagent output")) {',
    '  console.log(`Status: degraded\\nSummary: deterministic dogfood fixture completed\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'console.log(`GENERIC FAKE PI OUTPUT\\n${stdin}`);',
    "",
  ].join("\n");
}

test("Packaged review readiness pipeline dogfoods degraded reviewer fanout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-review-dogfood-"));
  const binDir = join(root, "bin");
  const stateDir = join(root, "run-state");
  const previousPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const fakePi = join(binDir, "pi");
    await writeFile(fakePi, fakePiScript(), "utf8");
    await chmod(fakePi, 0o755);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    const meta = startRun(
      {
        file: join(__dirname, "..", "recipes", "pipeline-review-readiness.json"),
        launch_source: "spawn",
        run_id: `review-dogfood-${process.pid}-${Date.now()}`,
        state_dir: stateDir,
        values: {
          current_model: "fake-provider/fake-model",
          current_thinking: "medium",
          lenses: ["correctness", "security", "tests"],
          min_successful_reviewers: 2,
          reviewer_concurrency: 2,
          scope: "fixture-scope",
          subagent_ttl_ms: 5000,
        },
      },
      process.cwd(),
    );

    await waitForFile(join(stateDir, "result.json"), 8000);
    const status = getRunStatus(stateDir);
    const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
    const progress = JSON.parse(await readFile(join(stateDir, "progress.json"), "utf8"));
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    const stderr = await readFile(join(stateDir, "stderr.log"), "utf8");
    const events = await readFile(join(stateDir, "events.jsonl"), "utf8");
    const outbox = await readFile(join(stateDir, "outbox.jsonl"), "utf8");

    assert.equal(meta.model_policy?.model.source, "inherited");
    assert.equal(status.status, "done");
    assert.equal(result.code, 0);
    assert.equal(progress.phase, "done");
    assert.equal(Number(progress.activeSubagents ?? 0), 0);
    assert.match(stdout, /Status: degraded/);
    assert.match(stdout, /parallel_status: degraded usable: 2 expected: 3 minimum: 2/);
    assert.match(stdout, /reviewer security simulated provider failure/);
    assert.doesNotMatch(stdout, /all parallel branches failed/);
    assert.equal(stderr.trim(), "");
    assert.match(events, /"prompt_file"/);
    assert.match(outbox, /"run_files"/);
    await waitForFile(join(stateDir, "prompts", "command-001.md"));
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
