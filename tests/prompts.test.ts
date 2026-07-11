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
    /template recipe/,
  );
  assert.match(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args, /file,lang/);
});

test("Onboarding system prompt explains recipe and async run model compactly", () => {
  const lines = Prompts.ONBOARDING_SYSTEM_PROMPT.split("\n");
  assert.equal(lines.length <= 14, true);
  assert.match(Prompts.ONBOARDING_SYSTEM_PROMPT, /Local-first actor memory/);
  assert.match(Prompts.ONBOARDING_SYSTEM_PROMPT, /Command templates stay sync/);
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /Actor-mode trigger: if work may outlive this turn/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /spawn -> message -> inspect instead of ad hoc shell backgrounding/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /Recipe imports are local variables/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /parent async:true creates one run/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /read the bundled actors skill first/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /README\/docs are not automatically in context/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /Prefer maintained packaged recipes\/pipelines/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /avoid runtime\/FIFO\/outbox vocabulary/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /wait for its terminal follow-up; do not schedule continuation loops/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /shell-free: string leaves split into executable \+ argv/,
  );
  assert.match(
    Prompts.ONBOARDING_SYSTEM_PROMPT,
    /also read the bundled swarm skill; the coordinator owns decomposition/,
  );
});

test("Registered tool prompt snippet includes the command template", () => {
  assert.equal(
    Prompts.formatRegisteredToolPromptSnippet("~/bin/tool {file}"),
    "Execute command template: ~/bin/tool {file}",
  );
});
