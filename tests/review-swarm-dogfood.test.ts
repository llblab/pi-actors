/**
 * Review-swarm dogfood fixture
 * Exercises the packaged review pipeline through the detached async runner with a fake local pi executable.
 */

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
    'const valueOptions = new Set(["--model", "--session-dir", "--thinking", "--tools"]);',
    "const promptFiles = [];",
    "const fragmentedPrompts = [];",
    "for (let index = 0; index < args.length; index += 1) {",
    "  const arg = args[index];",
    '  if (arg === "-p" || arg === "--print" || arg === "--no-tools") continue;',
    "  if (valueOptions.has(arg)) {",
    "    index += 1;",
    "    continue;",
    "  }",
    '  if (arg.startsWith("@")) promptFiles.push(arg.slice(1));',
    '  else if (!arg.startsWith("-")) fragmentedPrompts.push(arg);',
    "}",
    "if (fragmentedPrompts.length > 0 || promptFiles.length !== 1) {",
    '  console.error(`STRICT_PI_PROMPT_ARGV fragmented=${fragmentedPrompts.length} files=${promptFiles.length}`);',
    "  process.exit(64);",
    "}",
    'const prompt = readFileSync(promptFiles[0], "utf8");',
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
    '    console.log("reviewer security placeholder without evidence marker");',
    "    process.exit(0);",
    "  }",
    '  console.log(`ACTOR_REVIEW_RESULT\\nREVIEW ${lens}: evidence for fixture-scope`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Verify this claim")) {',
    '  console.log(`ACTOR_REVIEW_RESULT\\nVERIFICATION: usable reviewer evidence confirmed\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Merge these subagent outputs")) {',
    '  console.log(`ACTOR_REVIEW_RESULT\\nMERGED: preserved partial reviewer evidence\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Judge this merged review")) {',
    '  console.log(`ACTOR_REVIEW_RESULT\\nJUDGE: degraded confidence accepted\\n${stdin}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("Normalize this subagent output")) {',
    '  const refs = [...new Set(full.match(/ACTOR_EVIDENCE_REF: review-evidence\\.json#command-\\d{3}/g) || [])];',
    '  console.log(`ACTOR_REVIEW_RESULT\\nStatus: degraded\\nSummary: deterministic dogfood fixture completed\\n${refs.join("\\n")}`);',
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
    const evidence = JSON.parse(
      await readFile(join(stateDir, "review-evidence.json"), "utf8"),
    );

    assert.equal(meta.model_policy?.model.source, "inherited");
    assert.equal(status.status, "done", `${stdout}\n${stderr}`);
    assert.equal(result.code, 0);
    assert.equal(progress.phase, "done");
    assert.equal(Number(progress.activeSubagents ?? 0), 0);
    assert.match(stdout, /ACTOR_REVIEW_RESULT/);
    assert.match(stdout, /Status: degraded/);
    assert.doesNotMatch(stdout, /insufficient_data/);
    assert.equal(stderr.trim(), "");
    assert.match(events, /"prompt_file"/);
    assert.match(outbox, /"run_files"/);
    assert.equal(evidence.status, "done");
    assert.equal(evidence.model_policy.model.source, "inherited");
    assert.equal(evidence.report_evidence.claims_complete, false);
    assert.equal(
      evidence.report_evidence.complete_allowed,
      true,
      `${JSON.stringify(evidence.report_evidence)}\n${stdout}`,
    );
    assert.deepEqual(evidence.report_evidence.missing, []);
    assert.deepEqual(
      evidence.report_evidence.cited,
      [...evidence.report_evidence.required].sort(),
    );
    for (const reference of evidence.report_evidence.required) {
      assert.match(stdout, new RegExp(`ACTOR_EVIDENCE_REF: ${reference}`));
    }
    assert.equal(evidence.commands.length, 11);
    assert.equal(
      evidence.commands.filter(
        (command: { stage: string; semantic_acceptance: string }) =>
          command.stage === "preflight" &&
          command.semantic_acceptance === "accepted",
      ).length,
      4,
    );
    const reviewerEvidence = evidence.commands.filter(
      (command: { stage: string }) => command.stage === "reviewer",
    );
    assert.deepEqual(
      reviewerEvidence.map((command: { branch_index: string }) => command.branch_index),
      ["0", "1", "2"],
    );
    assert.equal(
      reviewerEvidence.filter(
        (command: { semantic_acceptance: string }) =>
          command.semantic_acceptance === "accepted",
      ).length,
      2,
    );
    const rejectedReviewers = evidence.commands.filter(
      (command: { stage: string; semantic_acceptance: string }) =>
        command.stage === "reviewer" &&
        command.semantic_acceptance === "rejected",
    );
    assert.equal(rejectedReviewers.length, 1);
    assert.equal(rejectedReviewers[0].exit_code, 0);
    assert.equal(rejectedReviewers[0].effective_exit_code, 65);
    assert.match(
      await readFile(
        join(stateDir, rejectedReviewers[0].attempts[0].stdout.path),
        "utf8",
      ),
      /placeholder without evidence marker/,
    );
    assert.equal(
      evidence.commands.every(
        (command: { attempts: unknown[]; prompt_file?: string }) =>
          command.attempts.length === 1 && Boolean(command.prompt_file),
      ),
      true,
    );
    const captureFiles = (
      await readdir(join(stateDir, "captures"), { recursive: true })
    ).filter((path) => /(?:stdout|stderr)\.log$/.test(path));
    assert.equal(captureFiles.length, evidence.commands.length * 2);
    assert.equal(new Set(captureFiles).size, captureFiles.length);
    await waitForFile(join(stateDir, "prompts", "command-001.md"));
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
