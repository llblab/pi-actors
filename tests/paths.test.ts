/**
 * Path helper regression tests
 * Covers agent directory, config, and extension temp path resolution
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { getAgentDir, getConfigPath, getExtensionTmpDir, getJobStateRoot, getJobTemplateRoot } from "../lib/paths.ts";

test("Agent dir defaults to the user pi agent directory", () => {
  assert.equal(getAgentDir({}), join(homedir(), ".pi", "agent"));
});

test("Agent dir honors PI_CODING_AGENT_DIR", () => {
  assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "./agent" }), resolve("./agent"));
});

test("Config path points to auto-tools.json under the agent dir", () => {
  assert.equal(getConfigPath("/agent"), "/agent/auto-tools.json");
});

test("Extension tmp dir lives under the pi agent tmp tree", () => {
  assert.equal(getExtensionTmpDir("/agent"), "/agent/tmp/pi-auto-tools");
});

test("Job state root lives under the extension tmp dir", () => {
  assert.equal(getJobStateRoot("/agent"), "/agent/tmp/pi-auto-tools/jobs");
});

test("Job template root lives under the agent dir", () => {
  assert.equal(getJobTemplateRoot("/agent"), "/agent/jobs");
});
