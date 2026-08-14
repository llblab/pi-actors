/**
 * Prompt copy regression tests
 * Covers register_tool prompt copy and registered-tool prompt snippets
 */

import assert from "node:assert/strict";
import test from "node:test";

import * as Prompts from "../lib/prompts.ts";

test("Register tool prompt copy names the register_tool tool explicitly", () => {
  assert.match(Prompts.REGISTER_TOOL_DESCRIPTION, /persistent custom tool/);
  assert.match(Prompts.REGISTER_TOOL_PROMPT_SNIPPET, /command templates/);
  assert.equal(
    Prompts.REGISTER_TOOL_GUIDELINES.every((item) =>
      item.includes("register_tool"),
    ),
    true,
  );
  assert.match(Prompts.REGISTER_TOOL_GUIDELINES.join("\n"), /callable_now/);
  assert.doesNotMatch(
    Prompts.REGISTER_TOOL_GUIDELINES.join("\n"),
    /immediately callable/,
  );
});

test("Register tool parameter descriptions cover public input fields", () => {
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name, /snake_case/);
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.from, /<skill>\/<recipe>/);
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.defaults, /caller-owned/);
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template, /Trusted command/);
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args, /file,lang/);
  assert.equal("values" in Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS, false);
});

test("Onboarding system prompt routes agents to authoritative Skills", () => {
  const prompt = Prompts.ONBOARDING_SYSTEM_PROMPT;
  assert.match(prompt, /active bundled Skills as the operating authority/);
  assert.match(prompt, /non-trivial pi-actors operation, diagnosis, or development.*actors Skill/);
  assert.match(prompt, /multiple actors or subagents.*additionally.*swarm Skill/);
  assert.match(prompt, /capability-specific selection or constraints.*owning capability Skill/);
  assert.match(prompt, /actors owns generic mechanics/);
  assert.match(prompt, /swarm owns multi-actor methodology/);
  assert.match(prompt, /Skill Recipe distinct from a registered tool/);
  assert.match(prompt, /Recipe spawn distinct from registered-tool invocation/);
  assert.match(prompt, /persistence or registration as distinct from current callability/);
  assert.match(prompt, /failure or disagreement, preserve the logical Recipe identity, stop, and follow actors diagnosis/);
  assert.match(prompt, /never bypass.*copied contracts, helper paths, shell evaluation, or background-process workarounds/);
  assert.match(prompt, /conflicts with actors.*follow actors.*stale capability guidance/);
  assert.match(prompt, /README and docs are human-facing references.*not the normal agent operating path/);
  assert.match(prompt, /AGENTS, source, and tests are implementation protocol and evidence/);
});

test("Onboarding system prompt does not duplicate product manuals", () => {
  const prompt = Prompts.ONBOARDING_SYSTEM_PROMPT;
  assert.doesNotMatch(
    prompt,
    /min_successful|accept_output|retire_when|\bfailure\s*[:=]|\brecover\s*[:=]|\brepeat\s*[:=]/,
  );
  assert.doesNotMatch(prompt, /\{value|\{flag|\?\?|placeholder/i);
  assert.doesNotMatch(prompt, /trace\.jsonl|controls\.jsonl|run\.json|state root/i);
  assert.doesNotMatch(prompt, /\b(?:380|512|1,?024|2,?048|4 MiB)\b/);
  assert.doesNotMatch(prompt, /watcher|review threshold|scheduler threshold/i);
  assert.doesNotMatch(
    prompt,
    /message|inspect|Trace|Control|callable_now|activation boundary|bash -lc|\beval\b|run\.json|trace\.jsonl|controls\.jsonl/i,
  );
});

test("Registered tool prompt snippet includes the command template", () => {
  assert.equal(
    Prompts.formatRegisteredToolPromptSnippet("~/bin/tool {file}"),
    "Execute command template: ~/bin/tool {file}",
  );
});
