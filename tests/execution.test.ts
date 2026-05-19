/**
 * Registered tool execution regression tests
 * Covers command-template execution payloads, command expansion, and failure propagation
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeRegisteredTool } from "../lib/execution.ts";
import type { RegisteredTool } from "../lib/config.ts";

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
  assert.equal(result.details.command, join(homedir(), "bin/transcribe"));
  assert.equal(result.details.truncated, false);
});

test("Registered tool execution normalizes typed runtime values", async () => {
  const calls: string[][] = [];
  await executeRegisteredTool(
    {
      name: "check_tool",
      description: "Run checker",
      template: "check {timeout} {speed} {dry_run} {mode}",
      args: ["timeout", "speed", "dry_run", "mode"],
      defaults: {},
      argTypes: {
        dry_run: { kind: "bool" },
        speed: { kind: "number" },
        mode: { kind: "enum", values: ["check", "fix"] },
        timeout: { kind: "int" },
      },
    },
    { timeout: 60, speed: 1.5, dry_run: false, mode: "fix" },
    async (_command, args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [["60", "1.5", "false", "fix"]]);
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

test("Registered tool execution repeats template nodes", async () => {
  const result = await executeRegisteredTool(
    {
      name: "repeat",
      description: "repeat test",
      args: [],
      defaults: {},
      template: {
        mode: "parallel",
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

test("Registered tool execution repeats template nodes from array length", async () => {
  const result = await executeRegisteredTool(
    {
      name: "prompt_fanout",
      description: "prompt fanout",
      args: ["prompts"],
      defaults: {},
      argTypes: { prompts: { kind: "array" } },
      template: {
        mode: "parallel",
        repeat: "{prompts.length}",
        template: "subagent {prompts[index]}",
      },
    },
    { prompts: ["left", "right", "third"] },
    async (_command, args) => ({ stdout: `${args[0]}\n`, stderr: "", code: 0, killed: false }),
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
          mode: "parallel",
          template: [
            { label: "gpt", timeout: 120000, template: "./review-gpt {file}" },
            { label: "kimi", timeout: 120000, template: "./review-kimi {file}" },
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
      return { stdout: `merged:\n${options?.stdin}`, stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    { command: "/work/prepare", stdin: undefined },
    { command: "/work/review-gpt", stdin: "prepared" },
    { command: "/work/review-kimi", stdin: "prepared" },
    {
      command: "/work/merge",
      stdin: "--- branch: gpt status: done ---\ngpt\n--- branch: kimi status: done ---\nkimi",
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

test("Registered tool execution reports degraded soft quorum without aborting", async () => {
  const result = await executeRegisteredTool(
    {
      ...tool,
      template: [
        {
          mode: "parallel",
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
        return { stdout: "", stderr: "provider balance exhausted", code: 1, killed: false };
      if (command.endsWith("merge"))
        return { stdout: String(options?.stdin), stderr: "", code: 0, killed: false };
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

test("Registered tool execution waits before delayed leaf steps", async () => {
  const startedAt = Date.now();
  const calls: Array<{ command: string; elapsed: number; timeout?: number }> = [];
  await executeRegisteredTool(
    {
      ...tool,
      template: [{ delay: 20, timeout: 123, template: "./slow-start {file}" }],
    },
    { file: "/tmp/a.ogg" },
    async (command, _args, options) => {
      calls.push({ command, elapsed: Date.now() - startedAt, timeout: options?.timeout });
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
      return { stdout: command.endsWith("first") ? "one" : "two", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls.map((call) => call.command), ["/work/first", "/work/second"]);
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
          mode: "parallel",
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
      return { stdout: command.endsWith("fast") ? "fast" : "slow", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  const fast = calls.find((call) => call.command === "/work/fast")!;
  const slow = calls.find((call) => call.command === "/work/slow")!;
  assert.ok(slow.elapsed - fast.elapsed >= 15, `${fast.elapsed} -> ${slow.elapsed}`);
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
    { code: 1, command: "/work/scan", killed: false },
  ]);
});

test("Registered tool execution aborts on critical composition failures", async () => {
  const calls: string[] = [];
  await assert.rejects(
    executeRegisteredTool(
      {
        ...tool,
        template: [
          { template: "./scan {file}", critical: true },
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
          mode: "parallel",
          template: [
            {
              failure: "branch",
              label: "agent-a",
              template: ["./work-a {file}", "./validate-a {file}", "./commit-a {file}"],
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
        return { stdout: String(options?.stdin), stderr: "", code: 0, killed: false };
      return { stdout: command.endsWith("work-b") ? "b" : "a", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.equal(calls.includes("/work/commit-a"), false);
  assert.equal(calls.at(-1), "/work/merge");
  assert.deepEqual(new Set(calls), new Set(["/work/work-a", "/work/work-b", "/work/validate-a", "/work/merge"]));
  assert.match(result.content[0].text, /branch: agent-a status: failed/);
  assert.match(result.content[0].text, /branch: agent-b status: done/);
  assert.equal(result.details.branches?.find((branch) => branch.label === "agent-a")?.status, "failed");
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
      return { stdout: command.endsWith("publish") ? "published" : "ok", stderr: "", code: 0, killed: false };
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
    { code: 1, command: "/work/validate", killed: false },
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
