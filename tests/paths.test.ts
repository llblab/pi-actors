/**
 * Path helper regression tests
 * Covers agent directory, config, recipe root, and extension temp path resolution
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import {
  getAgentDir,
  getConfigPath,
  getDraftSleepBatchDir,
  getDraftSleepStatePath,
  getExtensionTmpDir,
  getPackagedRecipeRoot,
  getRecipeDraftRoot,
  getRecipeRoot,
  getRunStateRoot,
  getToolReviewBatchDir,
  getToolReviewStatePath,
  isAutomaticRecipeReviewEnabled,
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

test("Automatic recipe review has one explicit environment opt-out", () => {
  assert.equal(isAutomaticRecipeReviewEnabled({}), true);
  for (const value of ["0", "false", "off", " OFF "]) {
    assert.equal(
      isAutomaticRecipeReviewEnabled({ PI_ACTORS_AUTOMATIC_REVIEW: value }),
      false,
    );
  }
  assert.equal(
    isAutomaticRecipeReviewEnabled({ PI_ACTORS_AUTOMATIC_REVIEW: "on" }),
    true,
  );
});

test("Config path points to the tool registry under the agent dir", () => {
  assert.equal(getConfigPath("/agent"), "/agent/tool-registry.json");
});

test("Extension tmp dir lives under the pi agent tmp tree", () => {
  assert.equal(getExtensionTmpDir("/agent"), "/agent/tmp/pi-actors");
});

test("Run state root lives under the extension tmp dir", () => {
  assert.equal(getRunStateRoot("/agent"), "/agent/tmp/pi-actors/runs");
});

test("Draft sleep state and immutable batches remain extension-local", () => {
  const batchId = "12345678-1234-1234-1234-123456789abc";
  assert.equal(
    getDraftSleepStatePath("/agent"),
    "/agent/tmp/pi-actors/draft-sleep/state.json",
  );
  assert.equal(
    getDraftSleepBatchDir(batchId, "/agent"),
    `/agent/tmp/pi-actors/draft-sleep/batches/${batchId}`,
  );
  assert.throws(
    () => getDraftSleepBatchDir("../escape", "/agent"),
    /Invalid draft sleep batch id/,
  );
});

test("Tool review state and immutable portfolios remain extension-local", () => {
  const batchId = "12345678-1234-1234-1234-123456789abc";
  assert.equal(
    getToolReviewStatePath("/agent"),
    "/agent/tmp/pi-actors/tool-review/state.json",
  );
  assert.equal(
    getToolReviewBatchDir(batchId, "/agent"),
    `/agent/tmp/pi-actors/tool-review/batches/${batchId}`,
  );
  assert.throws(
    () => getToolReviewBatchDir("../escape", "/agent"),
    /Invalid tool review id/,
  );
});

test("Recipe root lives under the agent dir", () => {
  assert.equal(getRecipeRoot("/agent"), "/agent/recipes");
});

test("Recipe draft root lives below the recipe root", () => {
  assert.equal(getRecipeDraftRoot("/agent"), "/agent/recipes/drafts");
});

test("Packaged recipe root resolves to the repository recipes directory", () => {
  assert.equal(basename(getPackagedRecipeRoot()), "recipes");
  assert.equal(getPackagedRecipeRoot(), resolve("recipes"));
});
