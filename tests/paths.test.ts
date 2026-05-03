/**
 * Registry path regression tests
 * Covers default and environment-provided agent/config path resolution
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import * as Paths from "../lib/paths.ts";

test("Agent dir defaults to the user pi agent directory", () => {
  assert.equal(Paths.getAgentDir({}), join(homedir(), ".pi", "agent"));
});

test("Agent dir honors PI_CODING_AGENT_DIR", () => {
  assert.equal(
    Paths.getAgentDir({ PI_CODING_AGENT_DIR: "./custom-agent" }),
    resolve("./custom-agent"),
  );
});

test("Config path points to auto-tools.json under the agent dir", () => {
  assert.equal(Paths.getConfigPath("/tmp/agent"), "/tmp/agent/auto-tools.json");
});
