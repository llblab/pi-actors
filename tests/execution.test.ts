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
  const calls: Array<{ command: string; args: string[]; timeout?: number }> =
    [];
  const result = await executeRegisteredTool(
    tool,
    { file: "/tmp/a b.ogg" },
    async (command, args, options) => {
      calls.push({ command, args, timeout: options?.timeout });
      return { stdout: "text", stderr: "", code: 0, killed: false };
    },
    "/work",
  );
  assert.deepEqual(calls, [
    {
      command: join(homedir(), "bin/transcribe"),
      args: ["/tmp/a b.ogg", "ru"],
      timeout: 120_000,
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "\ntext" }]);
  assert.equal(result.details.tool, "transcribe");
  assert.equal(result.details.command, join(homedir(), "bin/transcribe"));
  assert.equal(result.details.truncated, false);
});

test("Registered tool execution runs template sequences with previous stdout as stdin", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    stdin?: string;
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
      timeout: 120_000,
    },
    {
      command: "/work/second",
      args: ["ru"],
      stdin: "first out",
      timeout: 123,
    },
  ]);
  assert.deepEqual(result.content, [{ type: "text", text: "\nsecond out" }]);
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
