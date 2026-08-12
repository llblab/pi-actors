/**
 * Architecture invariant tests
 * Guards the coordinator entrypoint and namespace domain imports
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const indexSource = await readFile(
  new URL("../index.ts", import.meta.url),
  "utf8",
);
const runtimeSource = await readFile(
  new URL("../lib/runtime.ts", import.meta.url),
  "utf8",
);
const automaticReviewRuntimeSource = await readFile(
  new URL("../lib/automatic-review-runtime.ts", import.meta.url),
  "utf8",
);
const runUiRuntimeSource = await readFile(
  new URL("../lib/run-ui-runtime.ts", import.meta.url),
  "utf8",
);
const inspectorCommandSource = await readFile(
  new URL("../lib/inspector-command.ts", import.meta.url),
  "utf8",
);
const toolsSource = await readFile(
  new URL("../lib/tools.ts", import.meta.url),
  "utf8",
);
const toolsMessageSource = await readFile(
  new URL("../lib/tools-message.ts", import.meta.url),
  "utf8",
);
const reviewControlSource = await readFile(
  new URL("../lib/review-control.ts", import.meta.url),
  "utf8",
);
const changelogSource = await readFile(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf8",
);
const releaseGatesSource = await readFile(
  new URL("../scripts/release-gates.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const normalizeNewlines = (source: string): string => source.replaceAll("\r\n", "\n");
const validateWorkflowSource = normalizeNewlines(await readFile(
  new URL("../.github/workflows/validate.yml", import.meta.url),
  "utf8",
));
const releaseWorkflowSource = normalizeNewlines(await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
));
const automaticReviewerRecipes = await Promise.all(
  ["draft-review.json", "tool-review.json"].map(async (name) => ({
    name,
    source: await readFile(new URL(`../recipes/${name}`, import.meta.url), "utf8"),
  })),
);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

test("Entrypoint imports local domains through namespace imports", () => {
  const localImports = [
    ...indexSource.matchAll(/^import\s+(.+?)\s+from\s+"\.\/lib\//gm),
  ].map((match) => match[1]);
  assert.equal(localImports.length > 0, true);
  assert.equal(
    localImports.every((statement) => statement.startsWith("* as ")),
    true,
  );
});

test("Entrypoint exposes only the current Actor Inspector command", () => {
  assert.match(indexSource, /InspectorCommand\.registerActorInspectorCommand/);
  assert.match(inspectorCommandSource, /registerCommand\("actor-inspector"/);
  assert.doesNotMatch(indexSource, /registerCommand\("actors-consolidate-drafts"/);
  assert.doesNotMatch(indexSource, /registerCommand\("actors-inspector-toggle"/);
  assert.doesNotMatch(indexSource, /handleDraftConsolidationCommand/);
});

test("Entrypoint stays free of direct typebox and environment access", () => {
  assert.equal(indexSource.includes('from "typebox"'), false);
  assert.equal(indexSource.includes("process.env"), false);
});

test("Entrypoint delegates tool family composition to tools", () => {
  assert.match(indexSource, /Tools\.createCoreActorToolDefinitions/);
  assert.match(toolsSource, /createRegisterToolDefinition/);
  assert.equal(indexSource.includes('name: "register_tool"'), false);
});

test("Runtime reports recipe watcher failures", () => {
  assert.match(indexSource, /Runtime\.createRecipeToolReloadWatcher/);
  assert.match(runtimeSource, /Recipe live reload watcher failed/);
  assert.match(runtimeSource, /notifyFailure\(ctx\)/);
});

test("Session shutdown tears down exact-parent runs through the run UI runtime", () => {
  assert.match(indexSource, /pi\.on\("session_shutdown"/);
  assert.match(indexSource, /runUiRuntime\.shutdown\(event\.reason, ctx\)/);
  assert.match(runUiRuntimeSource, /AsyncRuns\.teardownRunsOwnedByParent/);
  assert.match(runUiRuntimeSource, /session_shutdown:\$\{eventReason\}/);
});

test("Entrypoint delegates low-level review and run lifecycle operations", () => {
  assert.match(indexSource, /AutomaticReviewRuntime\.createAutomaticReviewRuntime/);
  assert.match(indexSource, /RunUiRuntime\.createRunUiRuntime/);
  assert.doesNotMatch(indexSource, /AsyncRuns\.(?:startRun|listRuns|cancelRun|killRun)/);
  assert.doesNotMatch(indexSource, /create(?:DraftSleep|ToolReview)Scheduler/);
  assert.doesNotMatch(indexSource, /createRunStateWatcher|createRunTerminalReconciliationLoop/);
  assert.match(automaticReviewRuntimeSource, /DraftSleep\.createDraftSleepScheduler/);
  assert.match(automaticReviewRuntimeSource, /ToolReviewScheduler\.createToolReviewScheduler/);
});

test("Internal runtime input adapters use only Control terminology", () => {
  const sources = [
    indexSource,
    automaticReviewRuntimeSource,
    toolsSource,
    toolsMessageSource,
    reviewControlSource,
  ].join("\n");
  assert.doesNotMatch(sources, /handleRuntimeMessage|handleMessage/);
  assert.match(sources, /handleRuntimeControl/);
  assert.match(sources, /handleControl/);
  assert.doesNotMatch(toolsMessageSource, /\bgetTool\b/);
  assert.doesNotMatch(reviewControlSource, /\bsent\s*:/);
});

const publicGuidanceFiles = [
  "AGENTS.md",
  "BACKLOG.md",
  "README.md",
  ...listFiles("docs").filter((path) => path.endsWith(".md")),
  ...listFiles("skills").filter((path) => path.endsWith(".md")),
];

const operatorGuidanceFiles = [
  "README.md",
  ...listFiles("docs").filter((path) => path.endsWith(".md")),
  ...listFiles("skills").filter((path) => path.endsWith(".md")),
];

test("Public guidance avoids stale concrete model aliases", () => {
  const files = publicGuidanceFiles;
  const staleModelAliases = [
    /openai-codex\/gpt-5\.5/i,
    /deepseek\/deepseek-v4/i,
    /\bgpt-5\.5\b/i,
    /model:string=[^\s",`)]*gpt/i,
    /model=[^\s",`)]*openai/i,
  ];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pattern of staleModelAliases) {
      assert.doesNotMatch(
        content,
        pattern,
        `${file} should not mention ${pattern}`,
      );
    }
  }
});

test("Recipe installation guidance excludes internal reviewers from bulk install", () => {
  const content = readFileSync("docs/recipe-library.md", "utf8");
  assert.doesNotMatch(content, /cp\s+[^\n]*recipes\/\*\.json/);
  assert.match(content, /Do not bulk-copy `recipes\/\*\.json`/);
  assert.match(content, /`draft-review\.json` and `tool-review\.json`/);
  assert.match(content, /must not become user-installed callable tools/);
});

test("Operator guidance uses snake_case docs review examples", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /docs-review/,
      `${file} should use docs_review`,
    );
  }
});

test("Operator guidance avoids direct inbox and outbox wording", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /\binbox\/outbox\b|\bdirect inbox\b|\bdirect outbox\b/i,
      `${file} should describe Control and Trace instead of legacy routing`,
    );
  }
});

test("Operator guidance avoids stale FIFO queue wording", () => {
  for (const file of operatorGuidanceFiles) {
    const content = readFileSync(file, "utf8");
    assert.doesNotMatch(
      content,
      /FIFO queue|queued FIFO/i,
      `${file} should avoid stale transport queue wording`,
    );
  }
});

test("README first-run actor uses a shell-free command template", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /spawn template="sleep 30" as=run:demo/);
  assert.doesNotMatch(readme, /spawn template="[^"]*(?:&&|\|\||[|<>])[^"]*" as=run:demo/);
});

test("Platform guidance uses one portable FIFO and named-pipe envelope", () => {
  const readme = readFileSync("README.md", "utf8");
  const asyncRuns = readFileSync("docs/async-runs.md", "utf8");
  assert.match(readme, /Supported transports are Unix FIFO and Windows named pipe/);
  for (const content of [readme, asyncRuns]) {
    assert.match(content, /64 lowercase ASCII characters/);
    assert.match(content, /380 bytes/);
    assert.match(content, /512 bytes/);
    assert.doesNotMatch(content, /larger Control input|general Control input bound/);
  }
});

test("Platform-neutral validation includes protocol conformance", () => {
  assert.match(packageJson.scripts?.validate ?? "", /npm run conformance/);
  assert.doesNotMatch(packageJson.scripts?.validate ?? "", /npm audit/);
});

test("CI runs the dependency audit once on Ubuntu", () => {
  assert.equal(packageJson.scripts?.["audit:dependencies"], "npm audit --audit-level=high --omit=peer");
  assert.equal(validateWorkflowSource.match(/npm run audit:dependencies/g)?.length, 1);
  assert.match(validateWorkflowSource, /dependency-audit:[\s\S]*runs-on: ubuntu-latest/);
});

test("release gates register every shipped append-only writer", () => {
  assert.match(releaseGatesSource, /unregistered shipped append-only writer/);
  assert.match(releaseGatesSource, /lib\/runs-trace\.ts/);
  assert.match(releaseGatesSource, /lib\/runs-retention\.ts/);
  assert.match(releaseGatesSource, /scripts\/locker\.mjs/);
  assert.match(releaseGatesSource, /complete execution capture/);
  assert.match(releaseGatesSource, /user-declared artifact/);
});

test("CI release validation includes exact-tree, Domain DAG, and ABCd gates", () => {
  const releaseValidate = packageJson.scripts?.["release:validate"] ?? "";
  assert.match(releaseValidate, /npm run validate/);
  assert.match(releaseValidate, /node scripts\/release-gates\.mjs/);
  assert.match(validateWorkflowSource, /npm run release:validate/);
});

test("Release gate enforces a fixed shipped-line limit", () => {
  const declaration = releaseGatesSource.match(/const (\w*[Ss]hippedLines\w*) = ([\d_]+);/);
  assert.ok(declaration);
  assert.equal(Number(declaration[2].replaceAll("_", "")), 29_598);
  assert.match(releaseGatesSource, new RegExp(`check\\(shippedLines <=? ${declaration[1]}`));
});

test("CI workflows use reusable validation and Node 24 action runtimes", () => {
  assert.match(validateWorkflowSource, /^  workflow_call:$/m);
  assert.equal(validateWorkflowSource.match(/actions\/checkout@v7/g)?.length, 2);
  assert.equal(validateWorkflowSource.match(/actions\/setup-node@v7/g)?.length, 2);
  assert.equal(releaseWorkflowSource.match(/actions\/checkout@v7/g)?.length, 1);
  assert.equal(releaseWorkflowSource.match(/actions\/setup-node@v7/g)?.length, 1);
  for (const source of [validateWorkflowSource, releaseWorkflowSource]) {
    assert.doesNotMatch(source, /actions\/(?:checkout|setup-node)@v[1-6]\b/);
    assert.equal(
      [...source.matchAll(/node-version:\s*(\d+)/g)].every((match) => match[1] === "24"),
      true,
    );
  }
});

test("Release publication depends on complete validation and exact-tag preflight", () => {
  const validateJob = releaseWorkflowSource.match(
    /^  validate:[\s\S]*?(?=^  publish:)/m,
  )?.[0] ?? "";
  const publishJob = releaseWorkflowSource.match(/^  publish:[\s\S]*/m)?.[0] ?? "";
  assert.match(validateJob, /uses: \.\/\.github\/workflows\/validate\.yml/);
  assert.match(publishJob, /needs: validate/);
  assert.doesNotMatch(releaseWorkflowSource, /npm run release:validate/);
  assert.match(releaseWorkflowSource, /group: release-\$\{\{ github\.ref_name \}\}/);
  assert.match(releaseWorkflowSource, /cancel-in-progress: false/);
  assert.match(publishJob, /GITHUB_REF[^\n]*refs\/tags/);
  assert.match(publishJob, /HEAD\^\{commit\}/);
  assert.match(publishJob, /refs\/tags\/\$\{tagName\}\^\{commit\}/);
  assert.match(publishJob, /packageJson\.version !== version/);
  assert.match(publishJob, /packageLock\.version !== version/);
  assert.match(publishJob, /CHANGELOG\.md has no section/);
  assert.match(publishJob, /gh release view[\s\S]*gh release edit[\s\S]*gh release create/);
});

test("Release workflow scopes read and publication permissions per job", () => {
  const publishOffset = releaseWorkflowSource.indexOf("\n  publish:");
  assert.ok(publishOffset > 0);
  const nonPublish = releaseWorkflowSource.slice(0, publishOffset);
  const publishJob = releaseWorkflowSource.slice(publishOffset);
  assert.match(validateWorkflowSource, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(validateWorkflowSource, /contents: write|id-token: write/);
  assert.match(releaseWorkflowSource, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(nonPublish, /contents: write|id-token: write/);
  assert.match(publishJob, /permissions:\n      contents: write\n      id-token: write/);
  assert.equal(releaseWorkflowSource.match(/contents: write/g)?.length, 1);
  assert.equal(releaseWorkflowSource.match(/id-token: write/g)?.length, 1);
});

test("Release publishes through tokenless npm Trusted Publisher before GitHub Release", () => {
  const publishJob = releaseWorkflowSource.match(/^  publish:[\s\S]*/m)?.[0] ?? "";
  assert.match(publishJob, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(publishJob, /package-manager-cache: false/);
  assert.doesNotMatch(publishJob, /^\s+cache: npm$/m);
  assert.match(publishJob, /require npm >= 11\.5\.1/);
  assert.doesNotMatch(publishJob, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(publishJob, /^ {12,}NODE$/m);
  assert.doesNotMatch(publishJob, /uses: (?!actions\/(?:checkout|setup-node)@v7)/);
  assert.match(publishJob, /npm view "\$PACKAGE_NAME@\$VERSION" --json version gitHead/);
  assert.match(publishJob, /published\.gitHead !== process\.env\.TAG_COMMIT/);
  assert.match(publishJob, /grep -Eq 'E404\|404 Not Found'/);
  assert.match(publishJob, /npm publish --access public --provenance/);
  assert.match(publishJob, /for attempt in \$\(seq 1 20\)/);
  assert.match(publishJob, /npm view[\s\S]*&&\n\s*npm pack[\s\S]*&&\n\s*node --input-type=module/);
  assert.match(publishJob, /npm pack "\$PACKAGE_NAME@\$VERSION" --dry-run --json/);
  assert.match(publishJob, /dist\/pi-actors\/index\.js/);
  assert.match(publishJob, /dist\/skills\/actors\/SKILL\.md/);
  const npmVerification = publishJob.indexOf("Verify public npm package and packed manifest");
  const githubRelease = publishJob.indexOf("Publish GitHub release");
  assert.ok(npmVerification > publishJob.indexOf("npm publish --access public --provenance"));
  assert.ok(githubRelease > npmVerification);
});

test("Automatic recipe reviewers have no general filesystem tools", () => {
  for (const recipe of automaticReviewerRecipes) {
    const parsed = JSON.parse(recipe.source) as { template?: string };
    assert.match(parsed.template ?? "", /--no-tools/);
    assert.doesNotMatch(parsed.template ?? "", /--tools\s+read/);
    assert.match(parsed.template ?? "", /@\{input_path\}/);
  }
});

test("Unreleased changelog items avoid version literals", () => {
  const unreleased =
    changelogSource.match(
      /^## Unreleased\n(?<body>[\s\S]*?)(?=^## \d+\.\d+\.\d+)/m,
    )?.groups?.body ?? "";
  for (const line of unreleased
    .split("\n")
    .filter((line) => line.startsWith("- `"))) {
    assert.doesNotMatch(
      line,
      /\b\d+\.\d+\.\d+\b/,
      "Unreleased changelog item should rely on the section heading for versioning",
    );
  }
});

test("Every changelog release stays compact", () => {
  for (const section of normalizeNewlines(changelogSource).split("\n## ").slice(1)) {
    const [title, ...body] = section.split("\n");
    if (!/^\d+\.\d+\.\d+(?::|$)/.test(title)) continue;
    const records = body.filter((line) => /^(?:[-*+] |\d+\. )/.test(line));
    assert.ok(records.length <= 8, `${title}: ${records.length} changelog records`);
    for (const record of records) {
      assert.ok([...record].length <= 512, `${title}: changelog record exceeds 512 characters`);
    }
  }
});

test("Music player helper uses only Control and Trace state", () => {
  const script = readFileSync("scripts/music-player.mjs", "utf8");
  assert.match(script, /controls\.jsonl/);
  assert.match(script, /control-endpoint\.json/);
  assert.doesNotMatch(script, /inbox\.jsonl|outbox\.jsonl|message to=|player\.<command>/);
});

test("First-party scripts use only canonical Trace and Control journals", () => {
  const directTraceWrite = /(?:appendFileSync|writeFileSync|writeText(?:Atomic)?)\s*\(\s*[A-Za-z0-9_.]*?(?:trace|event)(?:Path|File)/iu;
  for (const file of [
    "scripts/async-runner.mjs",
    "scripts/locker.mjs",
    "scripts/music-player.mjs",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /importRuntimeModule\("runs-trace"\)/, file);
    if (file !== "scripts/async-runner.mjs") {
      assert.match(source, /importRuntimeModule\("runs-controls"\)/, file);
      assert.doesNotMatch(source, /function (?:read|write|claimControls|finalizeControls)\b/, file);
    }
    assert.match(source, /appendRunTraceEvent/, file);
    assert.doesNotMatch(source, directTraceWrite, file);
  }
  assert.match(
    readFileSync("scripts/release-gates.mjs", "utf8"),
    /direct Trace writer outside canonical authority/,
  );
});

test("Music player helper keeps player processes inside the run process group", () => {
  const script = readFileSync("scripts/music-player.mjs", "utf8");
  assert.doesNotMatch(
    script,
    /detached:\s*process\.platform\s*!==\s*["']win32["']/,
    "music-player must not detach backend players from the async run process group",
  );
  assert.match(
    script,
    /detached:\s*process\.platform\s*===\s*["']win32["']/,
    "music-player must isolate the Windows playback console group from its controller",
  );
  assert.match(
    script,
    /spawnSync\("taskkill", \["\/PID", String\(pid\), "\/T", "\/F"\]/,
    "music-player must terminate the Windows playback tree outside the controller process",
  );
});

test("Music player backend enum stays aligned across recipe docs and script", () => {
  const recipe = JSON.parse(readFileSync("recipes/music-player.json", "utf8"));
  const recipePlayers = recipe.args
    .find((arg: string) => arg.startsWith("player:enum("))
    ?.match(/^player:enum\((?<values>[^)]+)\)$/)
    ?.groups?.values.split(",");
  assert.deepEqual(recipePlayers, [
    "auto",
    "mpv",
    "afplay",
    "ffplay",
    "cvlc",
    "play",
    "wmp",
  ]);

  const docs = readFileSync("docs/recipe-library.md", "utf8");
  const docsPlayers = docs
    .match(/player:enum\((?<values>[^)]+)\)=auto/)
    ?.groups?.values.split(",");
  assert.deepEqual(docsPlayers, recipePlayers);

  const script = readFileSync("scripts/music-player.mjs", "utf8");
  const usagePlayers = script
    .match(/Supported players: (?<values>[^.]+)\./)
    ?.groups?.values.split(", ");
  assert.deepEqual(usagePlayers, recipePlayers);
});
