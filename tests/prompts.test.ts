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
});

test("Register tool parameter descriptions cover public input fields", () => {
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name, /snake_case/);
  assert.match(
    Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template,
    /job recipe/,
  );
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args, /file,lang/);
});


test("Onboarding system prompt explains template job model compactly", () => {
  const lines = Prompts.ONBOARDING_SYSTEM_PROMPT.split("\n");
  assert.equal(lines.length <= 22, true);
  assert.match(Prompts.ONBOARDING_SYSTEM_PROMPT, /job\(template\(mode/);
  assert.match(Prompts.ONBOARDING_SYSTEM_PROMPT, /Tasks are user work units/);
});

test("Registered tool prompt snippet includes the command template", () => {
  assert.equal(
    Prompts.formatRegisteredToolPromptSnippet("~/bin/tool {file}"),
    "Execute command template: ~/bin/tool {file}",
  );
});
