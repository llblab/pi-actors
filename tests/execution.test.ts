/**
 * Registered tool execution regression tests
 * Covers command-template execution payloads, command expansion, and failure propagation
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execCommandTemplate } from "../lib/command-templates.ts";
import { executeRegisteredTool } from "../lib/execution.ts";
import type { RegisteredTool } from "../lib/config.ts";
import { readResolvedRecipeConfig } from "../lib/recipes-references.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const tool: RegisteredTool = {
  name: "transcribe",
  description: "Transcribe audio",
  template: "~/bin/transcribe {file} {lang}",
  args: ["file", "lang"],
  defaults: { lang: "ru" },
};

test("Registered tool execution expands command and returns formatted payload", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    retry?: number;
    timeout?: number;
  }> = [];
  const result = await executeRegisteredTool(
    tool,
    { file: "/tmp/a b.ogg" },
    async (command, args, options) => {
      calls.push({
        command,
        args,
        retry: options?.retry,
        timeout: options?.timeout,
      });
      return { stdout: "text", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    {
      command: join(homedir(), "bin/transcribe"),
      args: ["/tmp/a b.ogg", "ru"],
      retry: undefined,
      timeout: undefined,
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "\ntext" }]);
  assert.equal(result.details.tool, "transcribe");
  assert.equal(
    result.details.command,
    `${join(homedir(), "bin/transcribe")} '/tmp/a b.ogg' ru`,
  );
  assert.equal(result.details.truncated, false);
});

test("Registered tool execution requires an exact review evidence marker line", async () => {
  const reviewTool: RegisteredTool = {
    ...tool,
    template: {
      accept_output: "review_evidence",
      template: "./review",
    },
  };
  for (const stdout of [
    "ACTOR_REVIEW_RESULT_BOGUS\nreport",
    "prefix ACTOR_REVIEW_RESULT\nreport",
    "report\nACTOR_REVIEW_RESULT",
  ]) {
    await assert.rejects(
      executeRegisteredTool(
        reviewTool,
        {},
        async () => ({ stdout, stderr: "", code: 0, killed: false }),
        "/work",
      ),
      /review evidence rejected: missing ACTOR_REVIEW_RESULT marker/,
    );
  }
  const accepted = await executeRegisteredTool(
    reviewTool,
    {},
    async () => ({
      stdout: "\n  \n ACTOR_REVIEW_RESULT \nreport",
      stderr: "",
      code: 0,
      killed: false,
    }),
    "/work",
  );
  assert.match(accepted.content[0].text, /ACTOR_REVIEW_RESULT/);
});

test("Registered tool execution accepts large marked evidence from the complete capture", async () => {
  const bytes = 1_100_000;
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: {
        accept_output: "review_evidence",
        template: `${process.execPath} -e "process.stdout.write(['ACTOR_REVIEW_RESULT','X'.repeat(${bytes})].join(String.fromCharCode(10)))"`,
      },
    },
    {},
    (command, args, options) =>
      execCommandTemplate(command, args, {
        ...options,
        captureLimitBytes: 128,
      }),
    process.cwd(),
  );
  assert.equal(result.details.code, 0);
  assert.equal(result.details.stdoutTruncated, true);
  assert.equal(result.details.stdoutBytes, bytes + 20);
  assert.equal(result.content[0].text.length < 256, true);
  assert.doesNotMatch(result.content[0].text, /ACTOR_REVIEW_RESULT/);
});

test("Registered tool execution passes actor recipe context to leaves", async () => {
  const contexts: unknown[] = [];
  await executeRegisteredTool(
    {
      name: "recipe_context_tool",
      description: "Run with actor context",
      template: {
        actorRecipeContext: { name: "entry", file: "/recipes/entry.json" },
        template: [
          "echo entry",
          {
            actorRecipeContext: { name: "child", file: "/recipes/child.json" },
            template: "echo child",
          },
        ],
      },
      args: [],
      defaults: {},
    },
    {},
    async (_command, _args, options) => {
      contexts.push(options?.actorRecipeContext);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(contexts, [
    { name: "entry", file: "/recipes/entry.json" },
    { name: "child", file: "/recipes/child.json" },
  ]);
});

test("Registered tool execution normalizes typed runtime values", async () => {
  const calls: string[][] = [];
  await executeRegisteredTool(
    {
      name: "check_tool",
      description: "Run checker",
      template: "check {request_timeout} {speed} {dry_run} {mode}",
      args: ["request_timeout", "speed", "dry_run", "mode"],
      defaults: {},
      argTypes: {
        dry_run: { kind: "bool" },
        speed: { kind: "number" },
        mode: { kind: "enum", values: ["check", "fix"] },
        request_timeout: { kind: "int" },
      },
    },
    { request_timeout: 60, speed: 1.5, dry_run: false, mode: "fix" },
    async (_command, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [["60", "1.5", "false", "fix"]]);
});

test("Registered tool execution lets runtime values override inherited default references", async () => {
  const calls: string[][] = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: {
        defaults: { file: "default.txt" },
        template: [
          {
            defaults: { target: "{file}" },
            template: "tail {target}",
          },
        ],
      },
    },
    { file: "/tmp/events.jsonl" },
    async (_command, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [["/tmp/events.jsonl"]]);
});

test("Registered tool execution runs template sequences with previous stdout as stdin", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    stdin?: string;
    retry?: number;
    timeout?: number;
  }> = [];
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        "./first {file}",
        { template: "./second {lang=ru}", timeout: 123 },
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command, args, options) => {
      calls.push({
        command,
        args,
        stdin: options?.stdin,
        retry: options?.retry,
        timeout: options?.timeout,
      });
      return {
        stdout: command.endsWith("first") ? "first out" : "second out",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    {
      command: "/work/first",
      args: ["/tmp/a.ogg"],
      stdin: undefined,
      retry: undefined,
      timeout: undefined,
    },
    {
      command: "/work/second",
      args: ["ru"],
      stdin: "first out",
      retry: undefined,
      timeout: 123,
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "\nsecond out" }]);
});

test("Registered tool execution exposes final spill metadata", async () => {
  const result = await executeRegisteredTool(
    { ...tool, template: "./noisy" },
    {},
    async () => ({
      stdout: "tail",
      stderr: "warn",
      code: 0,
      killed: false,
      stdoutBytes: 4096,
      stderrBytes: 4,
      stdoutFile: "/tmp/noisy-stdout.log",
      stdoutTruncated: true,
    }),
    "/work",
  );
  assert.equal(result.details.stdoutBytes, 4096);
  assert.equal(result.details.stdoutCapturedBytes, 4);
  assert.equal(result.details.stdoutTruncated, true);
  assert.equal(result.details.fullOutputPath, "/tmp/noisy-stdout.log");
});

test("Registered tool execution rejects truncated pipeline stdin", async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeRegisteredTool(
      { ...tool, template: ["./noisy", "./consumer"] },
      {},
      async (command) => {
        calls.push(command);
        return {
          stdout: "tail",
          stderr: "",
          code: 0,
          killed: false,
          stdoutBytes: 4096,
          stdoutFile: "/tmp/noisy-stdout.log",
          stdoutTruncated: true,
        };
      },
      "/work",
    ),
    /incomplete pipeline stdin.*capture path unreadable: \/tmp\/noisy-stdout\.log/,
  );
  assert.deepEqual(calls, ["/work/noisy"]);
});

test("Registered tool execution delivers complete spilled sequential stdout downstream", async () => {
  const bytes = 1_100_000;
  const noisy = `${process.execPath} -e "process.stdout.write('Y'.repeat(${bytes}))"`;
  const consumer = `${process.execPath} -e "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>console.log('BYTE_COUNT='+n))"`;
  const result = await executeRegisteredTool(
    { ...tool, template: [noisy, consumer] },
    {},
    (command, args, options) =>
      execCommandTemplate(command, args, {
        ...options,
        captureLimitBytes: 128,
      }),
    process.cwd(),
  );
  assert.match(result.content[0].text, new RegExp(`BYTE_COUNT=${bytes}`));
  assert.equal(result.details.stdoutTruncated, undefined);
  assert.equal(result.content[0].text.length < 256, true);
});

test("Registered tool execution skips nodes when when guard is false", async () => {
  const calls: string[] = [];
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        "first",
        { when: "enabled", template: "skip" },
        { when: "!enabled", template: "fallback" },
        "last",
      ],
    },
    { enabled: false },
    async (command, _args, options) => {
      calls.push(`${command}:${options?.stdin ?? ""}`);
      return { stdout: command, stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, ["first:", "fallback:first", "last:fallback"]);
  assert.deepEqual(result.content, [{ type: "text", text: "\nlast" }]);
});

test("Registered tool execution runs nested object template values", async () => {
  const calls: string[][] = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: {
        defaults: { message: "hello" },
        template: {
          defaults: { text: "{message}" },
          template: "echo {text}",
        },
      },
    },
    {},
    async (_command, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [["hello"]]);
});

test("Registered tool execution repeats nested object template nodes", async () => {
  const calls: string[][] = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: {
        repeat: "{items.length}",
        template: {
          defaults: { item: "{items[index]}" },
          template: "echo {item}",
        },
      },
    },
    { items: ["left", "right"] },
    async (_command, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [["left"], ["right"]]);
});

test("Registered tool execution repeats template nodes", async () => {
  const result = await executeRegisteredTool(
    {
      name: "repeat",
      description: "repeat test",
      args: [],
      defaults: {},
      template: {
        parallel: true,
        repeat: 3,
        template: `${process.execPath} -e "console.log(process.argv[1])" page{_(index+1)}-of-{repeat}`,
      },
    },
    {},
    async (_command, args) => ({
      stdout: `${args.at(-1)}\n`,
      stderr: "",
      code: 0,
      killed: false,
    }),
    process.cwd(),
  );
  const text = result.content[0].text;
  assert.match(text, /page01-of-3/);
  assert.match(text, /page02-of-3/);
  assert.match(text, /page03-of-3/);
  assert.equal(result.details.branches?.length, 3);
});

test("Registered tool execution rejects excessive parallel fanout", async () => {
  const cfg: RegisteredTool = {
    args: [],
    defaults: {},
    description: "fanout cap test",
    name: "fanout-cap",
    template: {
      parallel: true,
      repeat: 65,
      template: `${process.execPath} -e "console.log('x')"`,
    },
  };
  await assert.rejects(
    () =>
      executeRegisteredTool(
        cfg,
        {},
        async () => ({
          code: 0,
          killed: false,
          stderr: "",
          stdout: "",
        }),
        process.cwd(),
      ),
    /parallel fanout 65 exceeds limit 64/,
  );
});

test("Registered tool execution repeats template nodes from array length", async () => {
  const result = await executeRegisteredTool(
    {
      name: "prompt_fanout",
      description: "prompt fanout",
      args: ["prompts"],
      defaults: {},
      argTypes: { prompts: { kind: "array" } },
      template: {
        parallel: true,
        repeat: "{prompts.length}",
        template: "subagent {prompts[index]}",
      },
    },
    { prompts: ["left", "right", "third"] },
    async (_command, args) => ({
      stdout: `${args[0]}\n`,
      stderr: "",
      code: 0,
      killed: false,
    }),
    process.cwd(),
  );
  const text = result.content[0].text;
  assert.match(text, /left/);
  assert.match(text, /right/);
  assert.match(text, /third/);
  assert.equal(result.details.branches?.length, 3);
});

test("Registered tool execution runs nested parallel template nodes", async () => {
  const calls: Array<{ command: string; stdin?: string }> = [];
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        "./prepare {file}",
        {
          parallel: true,
          template: [
            { label: "gpt", timeout: 120000, template: "./review-gpt {file}" },
            {
              label: "kimi",
              timeout: 120000,
              template: "./review-kimi {file}",
            },
          ],
        },
        "./merge {file}",
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      calls.push({ command, stdin: options?.stdin });
      if (command.endsWith("prepare"))
        return { stdout: "prepared", stderr: "", code: 0, killed: false };
      if (command.endsWith("review-gpt"))
        return { stdout: "gpt", stderr: "", code: 0, killed: false };
      if (command.endsWith("review-kimi"))
        return { stdout: "kimi", stderr: "", code: 0, killed: false };
      return {
        stdout: `merged:\n${options?.stdin}`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    { command: "/work/prepare", stdin: undefined },
    { command: "/work/review-gpt", stdin: "prepared" },
    { command: "/work/review-kimi", stdin: "prepared" },
    {
      command: "/work/merge",
      stdin:
        "--- branch: gpt status: done ---\ngpt\n--- branch: kimi status: done ---\nkimi",
    },
  ]);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "\nmerged:\n--- branch: gpt status: done ---\ngpt\n--- branch: kimi status: done ---\nkimi",
    },
  ]);
  assert.deepEqual(result.details.softQuorum, {
    coverage: 1,
    degraded: false,
    done: 2,
    expected: 2,
    failed: 0,
    usable: true,
  });
});

test("Registered tool execution caps parallel branch concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  await executeRegisteredTool(
    {
      ...tool,
      template: {
        parallel: true,
        concurrency: 2,
        repeat: 5,
        template: "./branch {index}",
      },
    },
    {},
    async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.equal(maxActive, 2);
});

test("Registered tool execution delivers complete spilled parallel stdout downstream", async () => {
  const bytes = 1_100_000;
  const noisy = `${process.execPath} -e "process.stdout.write('X'.repeat(${bytes}))"`;
  const consumer = `${process.execPath} -e "let n=0;process.stdin.on('data',d=>n+=d.filter(b=>b===88).length);process.stdin.on('end',()=>console.log('X_COUNT='+n))"`;
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          parallel: true,
          template: [noisy, noisy],
        },
        consumer,
      ],
    },
    {},
    (command, args, options) =>
      execCommandTemplate(command, args, {
        ...options,
        captureLimitBytes: 128,
      }),
    process.cwd(),
  );
  assert.match(result.content[0].text, new RegExp(`X_COUNT=${bytes * 2}`));
  assert.equal(result.details.branches?.length, 2);
  assert.equal(
    result.details.branches?.every(
      (branch) => branch.stdoutTruncated && branch.stdoutBytes === bytes,
    ),
    true,
  );
  assert.equal(result.details.stdoutTruncated, undefined);
});

test("Registered tool execution reports degraded soft quorum without aborting", async () => {
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          parallel: true,
          template: [
            { label: "ok", timeout: 120000, template: "./ok {file}" },
            { label: "bad", timeout: 120000, template: "./bad {file}" },
          ],
        },
        "./merge {file}",
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      if (command.endsWith("bad"))
        return {
          stdout: "",
          stderr: "provider balance exhausted",
          code: 1,
          killed: false,
        };
      if (command.endsWith("merge"))
        return {
          stdout: String(options?.stdin),
          stderr: "",
          code: 0,
          killed: false,
        };
      return { stdout: "ok output", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.match(result.content[0].text, /branch: bad status: failed/);
  assert.deepEqual(result.details.softQuorum, {
    coverage: 0.5,
    degraded: true,
    done: 1,
    expected: 2,
    failed: 1,
    usable: true,
  });
});

test("Registered tool execution fails branch fanout when every branch is unusable", async () => {
  await assert.rejects(
    () =>
      executeRegisteredTool(
        {
          ...tool,
          template: [
            {
              failure: "branch",
              parallel: true,
              template: [
                { label: "empty", template: "./empty {file}" },
                { label: "bad", template: "./bad {file}" },
              ],
            },
          ],
        },
        { file: "/tmp/a.ogg" },
        async (command) => {
          if (command.endsWith("bad"))
            return { stdout: "", stderr: "boom", code: 1, killed: false };
          return { stdout: "", stderr: "", code: 0, killed: false };
        },
        "/work",
      ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /all parallel branches failed or produced empty output/);
      const details = (error as Error & { details?: any }).details;
      assert.equal(details?.failureReason, "all_branches_unusable");
      assert.deepEqual(details?.softQuorum, {
        coverage: 0.5,
        degraded: true,
        done: 1,
        expected: 2,
        failed: 1,
        usable: false,
      });
      const empty = details?.branches?.find((branch: any) => branch.label === "empty");
      const bad = details?.branches?.find((branch: any) => branch.label === "bad");
      assert.equal(empty?.failureReason, "empty_output");
      assert.equal(empty?.stdoutBytes, 0);
      assert.equal(empty?.stderrBytes, 0);
      assert.equal(bad?.failureReason, "nonzero_exit");
      assert.equal(bad?.stderrBytes, Buffer.byteLength("boom"));
      return true;
    },
  );
});

function createReviewCoordinatorTool(): RegisteredTool {
  const recipe = readResolvedRecipeConfig(
    join(__dirname, "..", "recipes", "subagent-review-coordinator.json"),
  )!;
  return {
    name: "review_coordinator_test",
    description: "Review coordinator fixture",
    args: recipe.args ?? [],
    defaults: recipe.defaults as Record<string, string>,
    template: recipe.template,
  };
}

const reviewCoordinatorValues = {
  claim: "The scope is ready.",
  evidence_policy: "Cite evidence.",
  judge_model: "fake-judge",
  lenses: ["correctness", "security"],
  merge_policy: "Preserve degraded evidence.",
  merger_model: "fake-merger",
  min_successful_reviewers: 1,
  output_format: "Markdown.",
  reviewer_concurrency: "",
  subagent_ttl_ms: 600000,
  reviewer_model: "fake-reviewer",
  risk_policy: "Preserve risks.",
  scope: "repo",
  thinking: "medium",
  tools: "",
  verifier_model: "fake-verifier",
};

function getPromptText(args: readonly string[]): string {
  return args.join(" ");
}

test("Review coordinator preflight fails before reviewer fanout", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      executeRegisteredTool(
        createReviewCoordinatorTool(),
        reviewCoordinatorValues,
        async (_command, args) => {
          const prompt = getPromptText(args);
          calls.push(prompt);
          if (prompt.includes("Preflight check for stage reviewer")) {
            return {
              stdout: "",
              stderr: "404 model not found",
              code: 7,
              killed: false,
            };
          }
          return { stdout: "ACTOR_PREFLIGHT_OK", stderr: "", code: 0, killed: false };
        },
        "/work",
      ),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /404 model not found/);
      return true;
    },
  );
  assert.equal(
    calls.some((prompt) => prompt.includes("Review repo through this lens")),
    false,
  );
  assert.deepEqual(
    calls.map((prompt) => prompt.match(/Preflight check for stage ([^\s.]+)/)?.[1]).sort(),
    ["judge", "merger", "reviewer", "verifier"],
  );
});

async function runReviewCoordinatorWithReviewerOutcomes(
  reviewerOutcomes: Array<boolean | string>,
  minSuccessful = 1,
): Promise<{ calls: string[]; resultText?: string; rejected?: unknown }> {
  const calls: string[] = [];
  let reviewerIndex = 0;
  try {
    const result = await executeRegisteredTool(
      createReviewCoordinatorTool(),
      {
        ...reviewCoordinatorValues,
        lenses: reviewerOutcomes.map((_ok, index) => `lens-${index + 1}`),
        min_successful_reviewers: minSuccessful,
      },
      async (_command, args, options) => {
        const prompt = getPromptText(args);
        calls.push(prompt);
        if (prompt.includes("Preflight check for stage")) {
          return { stdout: "ACTOR_PREFLIGHT_OK", stderr: "", code: 0, killed: false };
        }
        if (prompt.includes("Review repo through this lens")) {
          const outcome = reviewerOutcomes[reviewerIndex] ?? false;
          reviewerIndex += 1;
          if (typeof outcome === "string") {
            return { stdout: outcome, stderr: "", code: 0, killed: false };
          }
          return outcome
            ? { stdout: `ACTOR_REVIEW_RESULT\nreviewer ${reviewerIndex} evidence`, stderr: "", code: 0, killed: false }
            : { stdout: "", stderr: `reviewer ${reviewerIndex} unavailable`, code: 2, killed: false };
        }
        return {
          stdout: `ACTOR_REVIEW_RESULT\nstage output\n${options?.stdin ?? ""}`,
          stderr: "",
          code: 0,
          killed: false,
        };
      },
      "/work",
    );
    return { calls, resultText: result.content[0]?.text };
  } catch (error) {
    return { calls, rejected: error };
  }
}

test("Review coordinator fails with insufficient reviewer evidence before verifier and merger", async () => {
  const result = await runReviewCoordinatorWithReviewerOutcomes([false, false], 1);
  assert(result.rejected instanceof Error);
  assert.match(result.rejected.message, /parallel branch quorum not met/);
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Verify this claim")),
    false,
  );
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Merge these subagent outputs")),
    false,
  );
  assert.equal(
    (result.rejected as Error & { details?: any }).details?.failureReason,
    "parallel_quorum_not_met",
  );
});

test("Review coordinator rejects code-zero placeholder evidence before verifier and merger", async () => {
  const placeholder = "Waiting for the output format.";
  const result = await runReviewCoordinatorWithReviewerOutcomes([placeholder, placeholder], 1);
  assert(result.rejected instanceof Error);
  assert.match(result.rejected.message, /parallel branch quorum not met/);
  assert.match(result.rejected.message, /missing ACTOR_REVIEW_RESULT marker/);
  assert.match(result.rejected.message, /Waiting for the output format/);
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Verify this claim")),
    false,
  );
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Merge these subagent outputs")),
    false,
  );
});

test("Review coordinator preserves degraded accepted and rejected reviewer evidence", async () => {
  const result = await runReviewCoordinatorWithReviewerOutcomes([true, "Go ahead—provide the target format."], 1);
  assert.equal(result.rejected, undefined);
  assert.match(result.resultText ?? "", /parallel_status: degraded/);
  assert.match(result.resultText ?? "", /reviewer 1 evidence/);
  assert.match(result.resultText ?? "", /rejected_stdout: Go ahead—provide the target format/);
  assert.match(result.resultText ?? "", /missing ACTOR_REVIEW_RESULT marker/);
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Verify this claim")),
    true,
  );
  assert.equal(
    result.calls.some((prompt) => prompt.includes("Normalize this subagent output")),
    true,
  );
});

test("Review coordinator marks complete reviewer evidence when quorum succeeds", async () => {
  const result = await runReviewCoordinatorWithReviewerOutcomes([true, true], 2);
  assert.equal(result.rejected, undefined);
  assert.match(result.resultText ?? "", /parallel_status: complete/);
});

test("Review coordinator starts reviewer fanout only after preflight passes", async () => {
  const preflightStages = new Set<string>();
  let firstReviewerCall = -1;
  let callCount = 0;
  await executeRegisteredTool(
    createReviewCoordinatorTool(),
    reviewCoordinatorValues,
    async (_command, args) => {
      callCount += 1;
      const prompt = getPromptText(args);
      const stage = prompt.match(/Preflight check for stage ([^\s.]+)/)?.[1];
      if (stage) {
        preflightStages.add(stage);
        return { stdout: "ACTOR_PREFLIGHT_OK", stderr: "", code: 0, killed: false };
      }
      if (prompt.includes("Review repo through this lens")) {
        if (firstReviewerCall === -1) firstReviewerCall = callCount;
        assert.deepEqual([...preflightStages].sort(), [
          "judge",
          "merger",
          "reviewer",
          "verifier",
        ]);
      }
      return { stdout: `ACTOR_REVIEW_RESULT\nok ${callCount}`, stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.ok(firstReviewerCall > 4, `first reviewer call ${firstReviewerCall}`);
});

test("Registered tool execution throws formatted command failures", async () => {
  await assert.rejects(
    executeRegisteredTool(
      tool,
      { file: "/tmp/a.ogg" },
      async () => ({
        stdout: "partial",
        stderr: "boom",
        code: 1,
        killed: false,
      }),
      "/work",
    ),
    /Exit code 1[\s\S]*stderr:\nboom[\s\S]*stdout:\npartial/,
  );
});

test("Registered tool execution exposes high-risk template warnings", async () => {
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: "bash -c {script}",
      args: ["script"],
    },
    { script: "echo ok" },
    async () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
    "/work",
  );
  assert.match(result.details.templateWarnings?.[0] ?? "", /bash/);
});

test("Registered tool execution passes retry into template steps", async () => {
  const calls: Array<{ command: string; retry?: number }> = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: [{ template: "./flaky {file}", retry: 3 }],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      calls.push({ command, retry: options?.retry });
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [{ command: "/work/flaky", retry: 3 }]);
});

test("Registered tool execution resolves timeout from runtime values", async () => {
  const calls: Array<{ timeout?: number }> = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: {
        args: ["timeout_ms:int"],
        timeout: "{timeout_ms}",
        template: "./slow {file}",
      },
    },
    { file: "/tmp/a.ogg", timeout_ms: 123 },
    async (_command, _args, options) => {
      calls.push({ timeout: options?.timeout });
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [{ timeout: 123 }]);
});

test("Registered tool execution waits before delayed leaf steps", async () => {
  const startedAt = Date.now();
  const calls: Array<{ command: string; elapsed: number; timeout?: number }> =
    [];
  await executeRegisteredTool(
    {
      ...tool,
      template: [{ delay: 20, timeout: 123, template: "./slow-start {file}" }],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      calls.push({
        command,
        elapsed: Date.now() - startedAt,
        timeout: options?.timeout,
      });
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.equal(calls[0].command, "/work/slow-start");
  assert.equal(calls[0].timeout, 123);
  assert.ok(calls[0].elapsed >= 15, `elapsed ${calls[0].elapsed}`);
});

test("Registered tool execution waits before delayed sequence nodes", async () => {
  const startedAt = Date.now();
  const calls: Array<{ command: string; elapsed: number }> = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          delay: 20,
          template: ["./first {file}", "./second {file}"],
        },
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command) => {
      calls.push({ command, elapsed: Date.now() - startedAt });
      return {
        stdout: command.endsWith("first") ? "one" : "two",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  assert.deepEqual(
    calls.map((call) => call.command),
    ["/work/first", "/work/second"],
  );
  assert.ok(calls[0].elapsed >= 15, `elapsed ${calls[0].elapsed}`);
});

test("Registered tool execution applies parallel branch delays independently", async () => {
  const startedAt = Date.now();
  const calls: Array<{ command: string; elapsed: number }> = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          parallel: true,
          template: [
            { label: "fast", template: "./fast {file}" },
            { delay: 20, label: "slow", template: "./slow {file}" },
          ],
        },
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command) => {
      calls.push({ command, elapsed: Date.now() - startedAt });
      return {
        stdout: command.endsWith("fast") ? "fast" : "slow",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  const fast = calls.find((call) => call.command === "/work/fast")!;
  const slow = calls.find((call) => call.command === "/work/slow")!;
  assert.ok(
    slow.elapsed - fast.elapsed >= 15,
    `${fast.elapsed} -> ${slow.elapsed}`,
  );
});

test("Registered tool execution continues after non-critical composition failures", async () => {
  const calls: string[] = [];
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: ["./scan {file}", "./transcribe {file}"],
    },
    { file: "/tmp/a.ogg" },
    async (command) => {
      calls.push(command);
      if (command === "/work/scan")
        return { stdout: "", stderr: "skip", code: 1, killed: false };
      return { stdout: "text", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, ["/work/scan", "/work/transcribe"]);
  assert.deepEqual(result.content, [{ type: "text", text: "\ntext" }]);
  assert.deepEqual(result.details.nonCriticalFailures, [
    { code: 1, command: "/work/scan /tmp/a.ogg", killed: false },
  ]);
});

test("Registered tool execution aborts on root composition failures", async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeRegisteredTool(
      {
        ...tool,
        template: [
          { template: "./scan {file}", failure: "root" },
          "./transcribe {file}",
        ],
      },
      { file: "/tmp/a.ogg" },
      async (command) => {
        calls.push(command);
        return { stdout: "", stderr: "fatal", code: 1, killed: false };
      },
      "/work",
    ),
    /Exit code 1[\s\S]*stderr:\nfatal/,
  );
  assert.deepEqual(calls, ["/work/scan"]);
});

test("Registered tool execution stops a failed branch without cancelling siblings", async () => {
  const calls: string[] = [];
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          parallel: true,
          template: [
            {
              failure: "branch",
              label: "agent-a",
              template: [
                "./work-a {file}",
                "./validate-a {file}",
                "./commit-a {file}",
              ],
            },
            { label: "agent-b", template: "./work-b {file}" },
          ],
        },
        "./merge {file}",
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      calls.push(command);
      if (command === "/work/validate-a")
        return { stdout: "", stderr: "invalid", code: 2, killed: false };
      if (command === "/work/merge")
        return {
          stdout: String(options?.stdin),
          stderr: "",
          code: 0,
          killed: false,
        };
      return {
        stdout: command.endsWith("work-b") ? "b" : "a",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  assert.equal(calls.includes("/work/commit-a"), false);
  assert.equal(calls.at(-1), "/work/merge");
  assert.deepEqual(
    new Set(calls),
    new Set([
      "/work/work-a",
      "/work/work-b",
      "/work/validate-a",
      "/work/merge",
    ]),
  );
  assert.match(result.content[0].text, /branch: agent-a status: failed/);
  assert.match(result.content[0].text, /branch: agent-b status: done/);
  assert.equal(
    result.details.branches?.find((branch) => branch.label === "agent-a")
      ?.status,
    "failed",
  );
  assert.deepEqual(result.details.softQuorum, {
    coverage: 0.5,
    degraded: true,
    done: 1,
    expected: 2,
    failed: 1,
    usable: true,
  });
});

test("Registered tool execution retries a sequence with recover between attempts", async () => {
  const calls: string[] = [];
  let validationAttempts = 0;
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          failure: "branch",
          recover: "./reset {file}",
          retry: 2,
          template: ["./write {file}", "./validate {file}"],
        },
        "./publish {file}",
      ],
    },
    { file: "/tmp/a.ogg" },
    async (command) => {
      calls.push(command);
      if (command === "/work/validate") {
        validationAttempts += 1;
        if (validationAttempts === 1)
          return { stdout: "", stderr: "bad", code: 1, killed: false };
      }
      return {
        stdout: command.endsWith("publish") ? "published" : "ok",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    "/work/write",
    "/work/validate",
    "/work/reset",
    "/work/write",
    "/work/validate",
    "/work/publish",
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "\npublished" }]);
  assert.deepEqual(result.details.nonCriticalFailures, [
    { code: 1, command: "/work/validate /tmp/a.ogg", killed: false },
  ]);
});

test("Registered tool execution stops retries when recover fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeRegisteredTool(
      {
        ...tool,
        template: [
          {
            failure: "branch",
            recover: "./reset {file}",
            retry: 2,
            template: ["./write {file}", "./validate {file}"],
          },
        ],
      },
      { file: "/tmp/a.ogg" },
      async (command) => {
        calls.push(command);
        if (command === "/work/reset")
          return { stdout: "", stderr: "reset failed", code: 3, killed: false };
        if (command === "/work/validate")
          return { stdout: "", stderr: "bad", code: 1, killed: false };
        return { stdout: "ok", stderr: "", code: 0, killed: false };
      },
      "/work",
    ),
    /Exit code 3[\s\S]*stderr:\nreset failed/,
  );
  assert.deepEqual(calls, ["/work/write", "/work/validate", "/work/reset"]);
});
