/** Mirrors lib/recipes-context.ts; related contracts share this owner while retaining their fixtures and hooks. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  join,
  resolve,
} from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  describe,
} from "node:test";
import {
  appendRecipeContextToPiArgs,
  attachPiSessionDir,
  piPrintResponseMode,
  formatRecipeContextJsonl,
  materializePiPrintPromptArg,
  createEmptyRecipeResolutionContext,
  createRecipeResolutionContext,
} from "../lib/recipes-context.ts";
import {
  createActorExtensionRuntime,
} from "../lib/extension-runtime.ts";
import {
  createActiveSkillRecipeContext,
  resolveRecipeReferencePath,
} from "../lib/recipes-references.ts";

// Await each contract group so environment restoration and teardown finish before the next group builds.
await describe("Resolution context", { concurrency: false }, async () => {
test("Pi response selection accepts only direct text print, not prompts or event/control streams", () => {
  for (const args of [["-p", "answer"], ["--print", "@prompt.txt"], ["-p", "--mode", "text", "answer"],
    ["--mode=text", "-p", "answer"], ["--system-prompt", "--mode=json", "-p", "answer"], ["-p", "--", "--mode=json"]]) {
    assert.equal(piPrintResponseMode("pi", args), "text");
  }
  for (const args of [[], ["--help"], ["--mode", "json", "-p", "answer"], ["-p", "--mode=json", "answer"],
    ["-p", "--mode", "rpc", "answer"], ["-p", "--mode"], ["--system-prompt", "-p", "answer"]]) {
    assert.equal(piPrintResponseMode("pi", args), "unsupported");
  }
  assert.equal(piPrintResponseMode("node", ["-p", "answer"]), undefined);
});
/**
 * Actor recipe context bundle regression tests.
 * Covers JSONL provenance formatting and prompt injection for child pi actors.
 */



const records = [
  {
    depth: 0,
    import_path: [],
    logical_reference: "parent.json",
    name: "parent",
    recipe: { imports: { child: "child.json" }, template: [{ name: "child" }] },
    role: "entry" as const,
    source_file: "/recipes/parent.json",
    source_kind: "explicit_file_recipe" as const,
  },
  {
    alias: "child",
    depth: 1,
    import_path: ["child"],
    logical_reference: "child.json",
    name: "child-recipe",
    recipe: { template: "pi -p child prompt" },
    role: "import" as const,
    source_file: "/recipes/child.json",
    source_kind: "explicit_file_recipe" as const,
  },
];

test("Pi Node CLI preserves prompt/session placement and withholds non-text or lookalike programs", async () => {
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const args = [cli, "-p", "Do work"];
  assert.equal(piPrintResponseMode(process.execPath, args), "text");
  for (const mode of ["json", "rpc"]) assert.equal(piPrintResponseMode(process.execPath, [cli, "--mode", mode, "-p", "Do work"]), "unsupported");
  for (const wrong of [join(tmpdir(), "cli.js"), cli + ".other"]) {
    assert.equal(piPrintResponseMode(process.execPath, [wrong, "-p", "Do work"]), undefined);
    assert.deepEqual(attachPiSessionDir(process.execPath, [wrong, "-p", "Do work"], "/sessions").args, [wrong, "-p", "Do work"]);
  }
  const injected = appendRecipeContextToPiArgs(process.execPath, args, records);
  assert.equal(injected[0], cli); assert.ok(injected[2].startsWith("Do work\n\nActor recipe context bundle"));
  const attached = attachPiSessionDir(process.execPath, injected, "/sessions");
  assert.deepEqual(attached.args.slice(0, 3), [cli, "--session-dir", "/sessions"]);
  assert.equal(attached.sessionDir, "/sessions");
  const root = await mkdtemp(join(tmpdir(), "pi-node-cli-"));
  try {
    const path = join(root, "prompt.txt"), materialized = materializePiPrintPromptArg(process.execPath, attached.args, path);
    assert.deepEqual(materialized.args, [cli, "--session-dir", "/sessions", "-p", "@" + path]);
    assert.equal(await readFile(path, "utf8"), injected[2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Actor recipe context JSONL marks the current recipe node", () => {
  const jsonl = formatRecipeContextJsonl(records, {
    alias: "child",
    file: "/recipes/child.json",
    name: "child-recipe",
    path: "child",
  });
  const lines = jsonl.split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].you_are_here, undefined);
  assert.equal(lines[1].you_are_here, true);
  assert.equal(lines[1].you_are_here_path, "child");
  assert.equal(lines[1].name, "child-recipe");
  assert.equal(lines[1].logical_reference, "child.json");
  assert.equal(lines[1].source_file, undefined);
  assert.deepEqual(lines[1].recipe, { template: "pi -p child prompt" });
});

test("Actor recipe context is appended only to pi print prompts", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    ["--model", "m", "-p", "Do work"],
    records,
    { alias: "child" },
  );
  assert.equal(args[3].startsWith("Do work\n\nActor recipe context bundle"), true);
  assert.match(args[3], /"you_are_here":true/);
  assert.deepEqual(
    appendRecipeContextToPiArgs("echo", ["-p", "Do work"], records),
    ["-p", "Do work"],
  );
  assert.deepEqual(
    appendRecipeContextToPiArgs("pi", ["--model", "m", "Do work"], records),
    ["--model", "m", "Do work"],
  );
});

test("Actor recipe context skips print-mode options before appending to the prompt", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    [
      "-p",
      "--model",
      "m",
      "--thinking",
      "off",
      "--no-tools",
      "Review",
      "scope",
    ],
    records,
    { alias: "child" },
  );
  assert.deepEqual(args.slice(0, 7), [
    "-p",
    "--model",
    "m",
    "--thinking",
    "off",
    "--no-tools",
    "Review",
  ]);
  assert.equal(args[7].startsWith("scope\n\nActor recipe context bundle"), true);
});

test("Actor recipe context ignores pi file args when finding the print prompt", () => {
  const args = appendRecipeContextToPiArgs(
    "pi",
    ["-p", "@screen.png", "Describe", "image"],
    records,
    { alias: "child" },
  );
  assert.equal(args[1], "@screen.png");
  assert.equal(args[2], "Describe");
  assert.equal(args[3].startsWith("image\n\nActor recipe context bundle"), true);
});

test("Pi print commands receive isolated session storage without overriding explicit policy", () => {
  assert.deepEqual(
    attachPiSessionDir("pi", ["-p", "review"], "/run/sessions/command-001"),
    {
      args: ["--session-dir", "/run/sessions/command-001", "-p", "review"],
      sessionDir: "/run/sessions/command-001",
    },
  );
  for (const args of [
    ["--no-session", "-p", "review"],
    ["--session", "/tmp/existing.jsonl", "-p", "review"],
    ["--session-dir", "/tmp/sessions", "-p", "review"],
    ["--session-id", "fixed", "-p", "review"],
    ["--fork", "/tmp/parent.jsonl", "-p", "review"],
  ]) {
    assert.deepEqual(attachPiSessionDir("pi", args, "/run/managed"), { args });
  }
  assert.deepEqual(attachPiSessionDir("echo", ["-p", "review"], "/run/managed"), {
    args: ["-p", "review"],
  });
  assert.deepEqual(attachPiSessionDir("pi", ["--help"], "/run/managed"), {
    args: ["--help"],
  });
});

test("Fragmented Pi prompt argv and recipe context become one authoritative prompt file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-complete-prompt-file-"));
  try {
    const promptFile = join(root, "prompt.md");
    const contextArgs = appendRecipeContextToPiArgs(
      "pi",
      ["-p", "--model", "m", "Preflight", "check", "for", "stage", "reviewer.", "Confirm", "launch."],
      records,
      { alias: "child" },
    );
    const result = materializePiPrintPromptArg("pi", contextArgs, promptFile);
    assert.deepEqual(result.args, ["-p", "--model", "m", `@${promptFile}`]);
    const materializedPrompt = await readFile(promptFile, "utf8");
    assert.match(materializedPrompt, /^Preflight check for stage reviewer\. Confirm launch\./);
    assert.match(materializedPrompt, /Actor recipe context bundle follows/);
    assert.match(materializedPrompt, /"you_are_here":true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi print prompts can be materialized into prompt files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-prompt-file-"));
  try {
    const promptFile = join(root, "prompt.md");
    const prompt = "# Review\nQuoted \"text\", paths /tmp/a, and `code`.";
    const expectedPrompt = `Describe ${prompt}`;
    const result = materializePiPrintPromptArg(
      "pi",
      ["-p", "@screen.png", "Describe", prompt],
      promptFile,
    );
    assert.deepEqual(result.args, ["-p", "@screen.png", `@${promptFile}`]);
    assert.equal(result.promptFile, promptFile);
    assert.equal(result.promptBytes, Buffer.byteLength(expectedPrompt));
    assert.equal(await readFile(promptFile, "utf8"), expectedPrompt);
    assert.deepEqual(
      materializePiPrintPromptArg("echo", ["-p", "text"], join(root, "unused.md")),
      { args: ["-p", "text"] },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

});

await describe("Live resolution integration", { concurrency: false }, async () => {
/** Live Recipe resolution environment regressions. */



test("Recipe resolution contexts isolate session identity cwd and active Skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-resolution-context-"));
  try {
    const alphaSkill = join(root, "alpha-skill");
    const betaSkill = join(root, "beta-skill");
    await Promise.all([
      mkdir(join(alphaSkill, "recipes"), { recursive: true }),
      mkdir(join(betaSkill, "recipes"), { recursive: true }),
    ]);
    await Promise.all([
      import("node:fs/promises").then((fs) =>
        fs.writeFile(join(alphaSkill, "recipes", "task.json"), JSON.stringify({ template: "echo alpha" })),
      ),
      import("node:fs/promises").then((fs) =>
        fs.writeFile(join(betaSkill, "recipes", "task.json"), JSON.stringify({ template: "echo beta" })),
      ),
    ]);
    const alpha = createRecipeResolutionContext(
      "session-alpha",
      join(root, "alpha-work"),
      createActiveSkillRecipeContext([{ name: "alpha", baseDir: alphaSkill }]),
    );
    const beta = createRecipeResolutionContext(
      "session-beta",
      join(root, "beta-work"),
      createActiveSkillRecipeContext([{ name: "beta", baseDir: betaSkill }]),
    );
    assert.equal(alpha.sessionId, "session-alpha");
    assert.equal(alpha.cwd, resolve(root, "alpha-work"));
    assert.notEqual(alpha.generation, beta.generation);
    assert.equal(Object.isFrozen(alpha), true);
    assert.equal(
      resolveRecipeReferencePath("alpha/task", alpha.cwd, alpha.activeSkills),
      join(alphaSkill, "recipes", "task.json"),
    );
    assert.throws(
      () => resolveRecipeReferencePath("beta/task", alpha.cwd, alpha.activeSkills),
      /Active Skill Recipe not found: beta\/task/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Live tool calls receive the current session Recipe resolution context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-live-resolution-"));
  try {
    const alphaSkill = join(root, "alpha");
    const betaSkill = join(root, "beta");
    await Promise.all([
      mkdir(join(alphaSkill, "recipes"), { recursive: true }),
      mkdir(join(betaSkill, "recipes"), { recursive: true }),
    ]);
    const definitions = new Map<string, any>();
    const runtime = createActorExtensionRuntime({
      getActiveTools: () => [...definitions.keys()],
      getAllTools: () => [...definitions.values()],
      getThinkingLevel: () => "off",
      registerTool: (definition: any) => definitions.set(definition.name, definition),
      registerMessageRenderer: () => undefined,
      setActiveTools: () => undefined,
    } as never);
    runtime.registerCoreTools();
    const alphaSession = {
      cwd: join(root, "alpha-work"),
      sessionManager: { getSessionId: () => "session-alpha" },
    } as never;
    const betaSession = {
      cwd: join(root, "beta-work"),
      sessionManager: { getSessionId: () => "session-beta" },
    } as never;
    runtime.beforeAgentStart("base", [{ name: "alpha", baseDir: alphaSkill }], alphaSession);
    runtime.beforeAgentStart("base", [{ name: "beta", baseDir: betaSkill }], betaSession);
    const inspect = definitions.get("inspect");
    const alphaResult = await inspect.execute(
      "alpha-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      alphaSession,
    );
    const betaResult = await inspect.execute(
      "beta-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      betaSession,
    );
    assert.deepEqual(alphaResult.details.active_skill_recipe_identities, ["alpha"]);
    assert.deepEqual(betaResult.details.active_skill_recipe_identities, ["beta"]);
    runtime.beforeAgentStart("base", [{ name: "beta", baseDir: betaSkill }], alphaSession);
    const replaced = await inspect.execute(
      "replaced-inspect",
      { target: "recipes", view: "imports", verbose: true },
      undefined,
      undefined,
      alphaSession,
    );
    assert.deepEqual(replaced.details.active_skill_recipe_identities, ["beta"]);
    await assert.rejects(
      inspect.execute(
        "missing-inspect",
        { target: "recipes", view: "imports", verbose: true },
        undefined,
        undefined,
        {
          cwd: root,
          sessionManager: { getSessionId: () => "missing-session" },
        },
      ),
      /Recipe resolution context is unavailable for session missing-session/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Recipe resolution generation is stable and empty contexts are explicit", () => {
  const activeSkills = createActiveSkillRecipeContext([]);
  const first = createRecipeResolutionContext("session", ".", activeSkills);
  const second = createRecipeResolutionContext("session", ".", activeSkills);
  const empty = createEmptyRecipeResolutionContext("session", ".");
  assert.equal(first.generation, second.generation);
  assert.equal(first.generation, empty.generation);
  assert.deepEqual(empty.activeSkills.namespaces, {});
  assert.throws(
    () => createRecipeResolutionContext(" ", ".", activeSkills),
    /session id is required/,
  );
});

});
