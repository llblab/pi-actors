/**
 * Template recipe import regression tests
 * Covers recipe-layer imports, named import nodes, value references, and cycle checks
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPackagedRecipeRoot } from "../lib/paths.ts";
import {
  buildRecipeContextRecords,
  getRecipeIdFromPath,
  readResolvedRecipeConfig,
  resolveRecipePath,
} from "../lib/recipes-references.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Template recipes embed imported recipes as pipeline nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        name: "child",
        args: ["word:string", "suffix:string"],
        defaults: { suffix: "!" },
        template: "printf {word}{suffix}",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        name: "parent",
        imports: {
          child: {
            from: "child.json",
            values: { word: "hello" },
          },
        },
        template: [{ name: "child" }, "wc -c"],
      }),
    );

    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, [
      {
        args: ["word:string", "suffix:string"],
        defaults: { suffix: "!", word: "hello" },
        template: "printf {word}{suffix}",
      },
      "wc -c",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe context records preserve raw composition identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-context-"));
  try {
    const child = join(root, "child.json");
    const parent = join(root, "parent.json");
    await writeFile(
      child,
      JSON.stringify({
        defaults: { message: "hello" },
        template: "pi -p child",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child_alias: "child.json" },
        template: [{ name: "child_alias" }],
      }),
    );

    const records = buildRecipeContextRecords(parent);
    assert.deepEqual(
      records.map((record) => ({
        alias: record.alias,
        depth: record.depth,
        import_path: record.import_path,
        name: record.name,
        role: record.role,
      })),
      [
        {
          alias: undefined,
          depth: 0,
          import_path: [],
          name: "parent",
          role: "entry",
        },
        {
          alias: "child_alias",
          depth: 1,
          import_path: ["child_alias"],
          name: "child",
          role: "import",
        },
      ],
    );
    assert.deepEqual(records[1].recipe, {
      defaults: { message: "hello" },
      template: "pi -p child",
    });

    const config = readResolvedRecipeConfig(parent, [], {
      includeActorRecipeContext: true,
    })!;
    assert.equal(
      JSON.stringify(config.template).includes('"actorRecipeContext"'),
      true,
    );
    assert.equal(
      JSON.stringify(config.template).includes('"alias":"child_alias"'),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe paths expand repo and agent placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipeRoot = join(root, "recipes");
    assert.equal(
      resolveRecipePath("{repo}/recipes/base.json", recipeRoot),
      join(root, "recipes", "base.json"),
    );
    assert.equal(
      resolveRecipePath("{agent}/recipes/base.json", recipeRoot),
      join(
        process.env.PI_CODING_AGENT_DIR ??
          join(process.env.HOME!, ".pi", "agent"),
        "recipes",
        "base.json",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports resolve bare names by recipe-root priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    const userRoot = join(agentDir, "recipes");
    const adHocRoot = join(root, "adhoc");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRoot, { recursive: true }),
        fs.mkdir(adHocRoot, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRoot, "shared.json"),
      JSON.stringify({ template: "echo user" }),
    );
    await writeFile(
      join(adHocRoot, "shared.json"),
      JSON.stringify({ template: "echo adhoc" }),
    );
    await writeFile(
      join(adHocRoot, "parent.json"),
      JSON.stringify({
        imports: { shared: "shared" },
        template: { name: "shared" },
      }),
    );
    await writeFile(
      join(adHocRoot, "stdlib-parent.json"),
      JSON.stringify({
        imports: { utility: "utility-package-summary" },
        template: { name: "utility" },
      }),
    );

    const config = readResolvedRecipeConfig(join(adHocRoot, "parent.json"))!;
    assert.deepEqual(config.template, { template: "echo user" });
    await rm(join(userRoot, "shared.json"), { force: true });
    const fallbackConfig = readResolvedRecipeConfig(
      join(adHocRoot, "parent.json"),
    )!;
    assert.deepEqual(fallbackConfig.template, { template: "echo adhoc" });
    const stdlibConfig = readResolvedRecipeConfig(
      join(adHocRoot, "stdlib-parent.json"),
    )!;
    assert.match(JSON.stringify(stdlibConfig.template), /recipe-utils\.mjs/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe direct delegation resolves by recipe priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const agentDir = join(root, "agent");
    const userRoot = join(agentDir, "recipes");
    const adHocRoot = join(root, "adhoc");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await import("node:fs/promises").then((fs) =>
      Promise.all([
        fs.mkdir(userRoot, { recursive: true }),
        fs.mkdir(adHocRoot, { recursive: true }),
      ]),
    );
    await writeFile(
      join(userRoot, "shared.json"),
      JSON.stringify({
        async: true,
        args: ["message:string"],
        defaults: { message: "user" },
        mailbox: { accepts: ["player.stop"] },
        retire_when: "children_terminal",
        template: "echo {message}",
      }),
    );
    await writeFile(
      join(adHocRoot, "shared.json"),
      JSON.stringify({
        defaults: { message: "adhoc" },
        template: "echo {message}",
      }),
    );
    await writeFile(
      join(adHocRoot, "parent.json"),
      JSON.stringify({
        defaults: { message: "parent" },
        template: "shared",
      }),
    );
    await writeFile(
      join(adHocRoot, "stdlib-parent.json"),
      JSON.stringify({
        template: "utility-package-summary",
      }),
    );

    const config = readResolvedRecipeConfig(join(adHocRoot, "parent.json"))!;
    assert.equal(config.async, true);
    assert.deepEqual(config.args, ["message:string"]);
    assert.deepEqual(config.defaults, { message: "parent" });
    assert.deepEqual(config.mailbox, { accepts: ["player.stop"] });
    assert.equal(config.retire_when, "children_terminal");
    assert.deepEqual(config.template, {
      args: ["message:string"],
      defaults: { message: "parent" },
      template: "echo {message}",
    });
    await rm(join(userRoot, "shared.json"), { force: true });
    const fallbackConfig = readResolvedRecipeConfig(
      join(adHocRoot, "parent.json"),
    )!;
    assert.deepEqual(fallbackConfig.template, {
      defaults: { message: "parent" },
      template: "echo {message}",
    });
    const stdlibConfig = readResolvedRecipeConfig(
      join(adHocRoot, "stdlib-parent.json"),
    )!;
    assert.match(JSON.stringify(stdlibConfig.template), /recipe-utils\.mjs/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports expand repo placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipeRoot = join(root, "recipes");
    const child = join(recipeRoot, "child.json");
    const parent = join(recipeRoot, "parent.json");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(recipeRoot, { recursive: true }),
    );
    await writeFile(child, JSON.stringify({ template: "echo {word}" }));
    await writeFile(
      parent,
      JSON.stringify({
        imports: { child: "{repo}/recipes/child.json" },
        template: { name: "child", values: { word: "ok" } },
      }),
    );
    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.template, {
      defaults: { word: "ok" },
      template: "echo {word}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes derive recipe identity from filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipe = join(root, "file-identity.json");
    await writeFile(
      recipe,
      JSON.stringify({
        name: "ignored-name",
        description: "File identity recipe",
        template: "echo ok",
      }),
    );

    const config = readResolvedRecipeConfig(recipe)!;
    assert.equal(getRecipeIdFromPath(recipe), "file-identity");
    assert.equal(config.name, "file-identity");
    assert.equal(config.description, "File identity recipe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown recipes compile frontmatter and fenced templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-md-"));
  try {
    const child = join(root, "child.md");
    const parent = join(root, "parent.md");
    await writeFile(
      child,
      `---
description: Markdown child
args:
  - word:string
defaults:
  suffix: "!"
mailbox:
  accepts:
    - control.kill
---

Human notes are advisory.

\`\`\`template
printf {word}{suffix}
\`\`\`
`,
    );
    await writeFile(
      parent,
      `---
imports:
  child: child
---

\`\`\`json recipe
{
  "template": { "name": "child", "values": { "word": "hello" } }
}
\`\`\`
`,
    );

    const config = readResolvedRecipeConfig(parent)!;
    assert.equal(getRecipeIdFromPath(child), "child");
    assert.deepEqual(config.imports, { child: "child" });
    assert.deepEqual(config.template, {
      args: ["word:string"],
      defaults: { suffix: "!", word: "hello" },
      template: "printf {word}{suffix}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown recipes accept compact args and defaults authoring", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-md-compact-"));
  try {
    const recipe = join(root, "compact.md");
    await writeFile(
      recipe,
      `---
description: Compact Markdown
args: word:string, suffix:string
defaults:
  - word: hello
  - suffix: "!"
---

\`\`\`template
printf {word}{suffix}
\`\`\`
`,
    );

    const config = readResolvedRecipeConfig(recipe)!;
    assert.deepEqual(config.args, ["word:string", "suffix:string"]);
    assert.deepEqual(config.defaults, { suffix: "!", word: "hello" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reject unknown named import nodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const parent = join(root, "parent.json");
    await writeFile(
      parent,
      JSON.stringify({
        imports: {},
        template: [{ name: "missing" }],
      }),
    );

    assert.throws(
      () => readResolvedRecipeConfig(parent),
      /Unknown recipe import: missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes reference imported defaults and explicit values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const base = join(root, "base.json");
    const parent = join(root, "parent.json");
    await writeFile(
      base,
      JSON.stringify({
        name: "base-recipe",
        defaults: { profile: "safe", nested: { level: 3 }, enabled: true },
        template: "echo base",
      }),
    );
    await writeFile(
      parent,
      JSON.stringify({
        imports: {
          base: {
            from: "base.json",
            values: { target: "docs", empty: "" },
          },
        },
        defaults: {
          inherited_profile: "{base.defaults.profile}",
          inherited_level: "{base.defaults.nested.level}",
          target: "{base.values.target}",
          label: "{base.name}:{base.values.target}",
          fallback: "{base.defaults.missing=default-profile}",
          enabled_label: "{base.defaults.enabled?enabled:disabled}",
          empty_label: "{base.values.empty?present:empty}",
        },
        template:
          "run {base.defaults.profile} {base.values.target} {base.defaults.missing=fallback} {base.values.empty?yes:no} {label}",
      }),
    );

    const config = readResolvedRecipeConfig(parent)!;
    assert.deepEqual(config.defaults, {
      inherited_profile: "safe",
      inherited_level: 3,
      target: "docs",
      label: "base:docs",
      fallback: "default-profile",
      enabled_label: "enabled",
      empty_label: "empty",
    });
    assert.deepEqual(config.template, {
      defaults: {
        inherited_profile: "safe",
        inherited_level: 3,
        target: "docs",
        label: "base:docs",
        fallback: "default-profile",
        enabled_label: "enabled",
        empty_label: "empty",
      },
      template: "run safe docs fallback no {label}",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipes preserve mailbox declarations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const base = join(root, "base.json");
    const recipe = join(root, "mailbox.json");
    await writeFile(
      base,
      JSON.stringify({
        defaults: { message_type: "checkpoint.ready" },
        template: "echo base",
      }),
    );
    await writeFile(
      recipe,
      JSON.stringify({
        imports: { base: "base.json" },
        mailbox: {
          accepts: [
            "control.approve",
            { type: "control.revise", requires_response: true },
            7,
          ],
          emits: [
            "{base.defaults.message_type}",
            { type: "run.done", level: "info" },
            false,
          ],
        },
        template: "echo mailbox",
      }),
    );

    const config = readResolvedRecipeConfig(recipe)!;
    assert.deepEqual(config.mailbox, {
      accepts: [
        "control.approve",
        { type: "control.revise", requires_response: true },
      ],
      emits: ["checkpoint.ready", { type: "run.done", level: "info" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Packaged library recipes parse and resolve imports", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );

  assert.ok(files.length > 0);
  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.ok(config, `${file} should resolve`);
    assert.ok(config.template, `${file} should define a template`);
  }
});

test("Packaged async-run operations recipes expose actor run args", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  for (const file of [
    "utility-run-ops-snapshot.json",
    "pipeline-async-run-ops.json",
  ]) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.ok(
      config?.args?.includes("run_id:string"),
      `${file} should expose run_id:string`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("message_file")),
      `${file} should not expose message_file`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("event_file")),
      `${file} should not expose event_file`,
    );
  }
});

test("Packaged actor message recipes expose envelope-aligned type args", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  for (const file of ["subagent-message.json", "utility-actor-message.json"]) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.ok(
      config?.args?.includes("type:string"),
      `${file} should expose type:string`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("event_type")),
      `${file} should not expose event_type`,
    );
    assert.ok(
      !config?.args?.some((arg) => arg.startsWith("event_policy")),
      `${file} should not expose event_policy`,
    );
  }
});

test("Packaged async recipes declare mailbox metadata", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );

  const missing: string[] = [];
  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    if (config?.async === true && !config.mailbox) missing.push(file);
  }
  assert.deepEqual(missing, []);
});

test("Packaged recipes do not ship concrete model-version defaults", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const files = (await readdir(recipeDir)).filter((file) =>
    file.endsWith(".json"),
  );
  const modelLikeKey = /(^|_)models?$/;
  const concreteModelValue =
    /\b(openai|gpt|claude|deepseek|gemini|mistral|codex)\b/i;

  for (const file of files) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    const defaults = config?.defaults ?? {};
    for (const [key, value] of Object.entries(defaults)) {
      if (modelLikeKey.test(key)) {
        assert.equal(
          value,
          "{current_model}",
          `${file} may default ${key} only through current-model inheritance`,
        );
      }
      assert.ok(
        !concreteModelValue.test(JSON.stringify(value)),
        `${file} should not ship concrete model provider/version defaults in ${key}`,
      );
    }
  }
});

test("Packaged review recipes inherit current model and thinking by default", () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const expectedModelDefaults: Record<string, string[]> = {
    "lens-swarm.json": ["model"],
    "pipeline-review-readiness.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "pipeline-release-readiness.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "subagent-review-coordinator.json": [
      "reviewer_model",
      "verifier_model",
      "merger_model",
      "judge_model",
    ],
    "subagent-preflight.json": ["model"],
    "subagent-review.json": ["model"],
    "subagent-verify.json": ["model"],
    "subagent-merge.json": ["model"],
    "subagent-judge.json": ["model"],
    "subagent-normalize.json": ["model"],
  };
  const expectedThinkingDefaults = [
    "lens-swarm.json",
    "pipeline-review-readiness.json",
    "pipeline-release-readiness.json",
    "subagent-review-coordinator.json",
    "subagent-preflight.json",
    "subagent-review.json",
    "subagent-verify.json",
    "subagent-merge.json",
    "subagent-judge.json",
    "subagent-normalize.json",
  ];
  for (const [file, keys] of Object.entries(expectedModelDefaults)) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    for (const key of keys) {
      assert.equal(config?.defaults?.[key], "{current_model}", `${file}:${key}`);
    }
  }
  for (const file of expectedThinkingDefaults) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    assert.equal(config?.defaults?.thinking, "{current_thinking}", `${file}:thinking`);
  }
});

test("Packaged review coordinator preflights stage models before reviewer fanout", () => {
  const config = readResolvedRecipeConfig(
    join(__dirname, "..", "recipes", "subagent-review-coordinator.json"),
  )!;
  const steps = (config.template as { template?: unknown }).template;
  assert.ok(Array.isArray(steps));
  const first = steps[0] as Record<string, unknown>;
  assert.equal(first.parallel, true);
  assert.equal(first.failure, "root");
  assert.match(JSON.stringify(first), /ACTOR_PREFLIGHT_OK|Preflight check/);
  assert.match(JSON.stringify(steps[1]), /repeat.*lenses|reviewer/);
});

test("Packaged actor worker recipe stays mailbox-only and cross-platform", () => {
  const config = readResolvedRecipeConfig(
    join(getPackagedRecipeRoot(), "actor-worker.json"),
  )!;
  assert.deepEqual(config.mailbox?.accepts, ["task.assign", "control.kill"]);
  const template = JSON.stringify(config.template);
  assert.match(template, /actor-worker\.mjs/);
  assert.match(template, /--stale-claim-ms/);
  assert.match(template, /--write-artifacts/);
  assert.deepEqual(Object.keys(config.artifacts ?? {}).sort(), [
    "journal",
    "results",
    "status",
  ]);
  assert.doesNotMatch(template, /control\.fifo|mkfifo|named-pipe/);
});

test("Packaged async recipes declare stop and cancel only for actor-domain handlers", async () => {
  const allowed = new Set([
    "coordinator-locker.json",
    "locker.json",
    "music-player.json",
  ]);
  const recipeDir = join(__dirname, "..", "recipes");
  const asyncFiles = (await readdir(recipeDir)).filter((file) => {
    if (!file.endsWith(".json")) return false;
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    return config?.async === true;
  });

  for (const file of asyncFiles) {
    const accepts =
      readResolvedRecipeConfig(join(recipeDir, file))?.mailbox?.accepts ?? [];
    const hasDomainStop =
      accepts.includes("control.stop") || accepts.includes("control.cancel");
    assert.equal(
      hasDomainStop,
      allowed.has(file),
      `${file} should declare stop/cancel only when actor-domain handling is meaningful`,
    );
  }
});

test("Packaged async recipes expose actor-native kill control", async () => {
  const recipeDir = join(__dirname, "..", "recipes");
  const asyncFiles = (await readdir(recipeDir)).filter((file) => {
    if (!file.endsWith(".json")) return false;
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    return config?.async === true;
  });

  for (const file of asyncFiles) {
    const config = readResolvedRecipeConfig(join(recipeDir, file));
    const accepts = config?.mailbox?.accepts ?? [];
    assert.ok(
      accepts.includes("control.kill"),
      `${file} should expose actor-native kill control`,
    );
  }
});

test("Template recipe rejects oversized files before parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const recipe = join(root, "huge.json");
    await writeFile(
      recipe,
      JSON.stringify({ template: "echo ok", padding: "x".repeat(1024 * 1024) }),
    );
    assert.throws(
      () => readResolvedRecipeConfig(recipe),
      /Recipe file exceeds size limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports reject excessive depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    for (let index = 0; index < 34; index += 1) {
      await writeFile(
        join(root, `r${index}.json`),
        JSON.stringify({
          ...(index < 33 ? { imports: { next: `r${index + 1}.json` } } : {}),
          template: "echo ok",
        }),
      );
    }
    assert.throws(
      () => readResolvedRecipeConfig(join(root, "r0.json")),
      /Recipe import depth exceeds limit 32/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Template recipe imports reject cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-recipes-"));
  try {
    const a = join(root, "a.json");
    const b = join(root, "b.json");
    await writeFile(
      a,
      JSON.stringify({ imports: { b: "b.json" }, template: "echo a" }),
    );
    await writeFile(
      b,
      JSON.stringify({ imports: { a: "a.json" }, template: "echo b" }),
    );
    assert.throws(() => readResolvedRecipeConfig(a), /Cyclic recipe import/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
