/**
 * Path helper regression tests
 * Covers agent directory, config, recipe root, and extension temp path resolution
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  getAgentDir,
  getConfigPath,
  getExtensionTmpDir,
  getRecipeRoot,
  getRunStateRoot,
} from "../lib/paths.ts";

test("Agent dir defaults to the user pi agent directory", () => {
  assert.equal(getAgentDir({}), join(homedir(), ".pi", "agent"));
});

test("Agent dir honors PI_CODING_AGENT_DIR", () => {
  assert.equal(
    getAgentDir({ PI_CODING_AGENT_DIR: "./agent" }),
    resolve("./agent"),
  );
});

test("Config path points to tools.json under the agent dir", () => {
  assert.equal(getConfigPath("/agent"), "/agent/tools.json");
});

test("Extension tmp dir lives under the pi agent tmp tree", () => {
  assert.equal(getExtensionTmpDir("/agent"), "/agent/tmp/pi-actors");
});

test("Run state root lives under the extension tmp dir", () => {
  assert.equal(getRunStateRoot("/agent"), "/agent/tmp/pi-actors/runs");
});

test("Recipe root lives under the agent dir", () => {
  assert.equal(getRecipeRoot("/agent"), "/agent/recipes");
});
