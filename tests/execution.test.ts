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
  label: "Transcribe",
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
  assert.equal(result.details.command, "~/bin/transcribe");
  assert.equal(result.details.truncated, false);
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
