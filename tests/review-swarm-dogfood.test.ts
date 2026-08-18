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
import { createActiveSkillRecipeContext } from "../lib/recipes-references.ts";

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
    "if (fragmentedPrompts.length > 0 || promptFiles.length < 1) {",
    '  console.error(`STRICT_PI_PROMPT_ARGV fragmented=${fragmentedPrompts.length} files=${promptFiles.length}`);',
    "  process.exit(64);",
    "}",
    'const prompt = promptFiles.map((file) => readFileSync(file, "utf8")).join("\\n");',
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
    '  const refs = [...new Set(full.match(/ACTOR_EVIDENCE_REF: execution\\.json#command-\\d{3}/g) || [])];',
    '  console.log(`ACTOR_REVIEW_RESULT\\nStatus: degraded\\nSummary: deterministic dogfood fixture completed\\n${refs.join("\\n")}`);',
    "  process.exit(0);",
    "}",
    "",
    'if (task.includes("immutable pi-actors draft batch")) {',
    '  console.log(`DRAFT_REVIEW_RESULT\\n{"batchId":"dogfood","createdAt":"2026-01-01T00:00:00.000Z","decisions":[]}`);',
    "  process.exit(0);",
    "}",
    "",
    'console.log(`ACTOR_REVIEW_RESULT\\nGENERIC FAKE PI OUTPUT\\n${stdin}`);',
    "",
  ].join("\n");
}

test("Skill capability packs execute qualified source workflows", {
  skip: process.platform === "win32" ? "requires a POSIX fake pi executable" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-capability-packs-"));
  const binDir = join(root, "bin");
  const previousPath = process.env.PATH;
  try {
    await mkdir(binDir, { recursive: true });
    const fakePi = join(binDir, "pi");
    const fakeFfplay = join(binDir, "ffplay");
    const musicSource = join(root, "track.wav");
    await writeFile(fakePi, fakePiScript(), "utf8");
    await writeFile(fakeFfplay, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(musicSource, "audio fixture", "utf8");
    await chmod(fakePi, 0o755);
    await chmod(fakeFfplay, 0o755);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const skillContext = createActiveSkillRecipeContext(
      ["actors", "artifacts", "music-player", "project-work", "recipe-memory", "swarm"]
        .map((name) => ({ name, baseDir: join(__dirname, "..", "skills", name) })),
    );
    const inputPath = join(root, "draft-input.json");
    await writeFile(inputPath, "{}\n");
    const workflows = [
      {
        recipe: "project-work/repo-health",
        values: {
          repo: process.cwd(), docs_dir: "docs", validation_command: "true",
          artifact_path: join(root, "repo-health.md"), model: "fake/model",
          current_model: "fake/model", current_thinking: "off",
        },
      },
      {
        recipe: "project-work/release-readiness",
        values: {
          scope: process.cwd(), version: "0.46.0", validation_command: "true",
          artifact_path: join(root, "release-readiness.md"), lenses: ["release"],
          reviewer_model: "fake/model", verifier_model: "fake/model",
          merger_model: "fake/model", judge_model: "fake/model", thinking: "off",
          min_successful_reviewers: 1, subagent_ttl_ms: 5000,
          current_model: "fake/model", current_thinking: "off",
        },
      },
      {
        recipe: "swarm/quorum-review",
        values: {
          prompt: "Review capability pack dogfood", models: ["fake/model"],
          merger_model: "fake/model", judge_model: "fake/model",
          current_model: "fake/model", current_thinking: "off",
        },
      },
      {
        recipe: "artifacts/bundle",
        values: {
          input: "Capability pack dogfood evidence", artifact_path: join(root, "bundle.md"),
          manifest_path: join(root, "bundle.json"), model: "fake/model",
          write_mode: "overwrite", current_model: "fake/model", current_thinking: "off",
        },
      },
      {
        recipe: "music-player/playback",
        values: { source: musicSource, loop: false, volume: 70, player: "ffplay" },
      },
      {
        recipe: "recipe-memory/draft-review",
        values: { input_path: inputPath, model: "fake/model", thinking: "off" },
      },
    ];
    for (const [index, workflow] of workflows.entries()) {
      const stateDir = join(root, `run-${index}`);
      const meta = startRun(
        {
          file: workflow.recipe,
          launch_source: "spawn",
          ...(workflow.recipe === "music-player/playback"
            ? {}
            : { run_id: `capability-pack-${index}-${process.pid}-${Date.now()}` }),
          state_dir: stateDir,
          values: workflow.values,
        },
        process.cwd(),
        { skillContext },
      );
      await waitForFile(join(stateDir, "result.json"), 30000);
      const status = getRunStatus(stateDir);
      const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
      const stderr = await readFile(join(stateDir, "stderr.log"), "utf8");
      assert.equal(status.status, "done", `${workflow.recipe}\n${stdout}\n${stderr}`);
      assert.equal(meta.recipe_context_records?.[0].logical_reference, workflow.recipe);
      assert.equal(meta.recipe_context_records?.[0].source_kind, "active_skill_component");
    }
    assert.equal((await readFile(join(root, "bundle.md"), "utf8")).length > 0, true);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Packaged review readiness pipeline dogfoods degraded reviewer fanout", {
  skip: process.platform === "win32" ? "requires a POSIX fake pi executable" : false,
}, async () => {
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
        file: "swarm/review-readiness",
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
      {
        skillContext: createActiveSkillRecipeContext([
          { name: "swarm", baseDir: join(__dirname, "..", "skills", "swarm") },
        ]),
      },
    );
    await waitForFile(join(stateDir, "result.json"), 20000);
    const status = getRunStatus(stateDir);
    const result = JSON.parse(await readFile(join(stateDir, "result.json"), "utf8"));
    const progress = JSON.parse(await readFile(join(stateDir, "progress.json"), "utf8"));
    const stdout = await readFile(join(stateDir, "stdout.log"), "utf8");
    const stderr = await readFile(join(stateDir, "stderr.log"), "utf8");
    const trace = await readFile(join(stateDir, "trace.jsonl"), "utf8");
    const evidence = JSON.parse(
      await readFile(join(stateDir, "execution.json"), "utf8"),
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
    assert.match(trace, /"prompt_file"/);
    assert.match(trace, /"run_files"/);
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
