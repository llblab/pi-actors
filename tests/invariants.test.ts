/**
 * Architecture invariant tests
 * Guards the coordinator entrypoint and namespace domain imports
 */

import assert from "node:assert/strict";
import { globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Test files mirror library owners except explicit cross-domain and package contracts", () => {
  const exceptions: Record<string, string> = {
    "agent-journeys.test.ts": "Cross-domain public agent journeys",
    "capability-packs-dogfood.test.ts": "Capability-pack integration",
    "installed.scripts.test.ts": "Source and packed-package journeys",
    "invariants.test.ts": "Architecture and repository invariants",
    "invocation-contract.test.ts": "Cross-tool invocation contract",
    "recipe-utils.scripts.test.ts": "Capability-owned utility scripts",
    "registration-truth.test.ts": "Registry, activation and runtime integration",
    "release-workflow.test.ts": "GitHub publication workflow",
    "resource-locker.scripts.test.ts": "Capability-owned resource-locker scripts",
    "review-swarm-dogfood.test.ts": "Cross-domain review workflow",
    "run-kernel-dogfood.test.ts": "Public Run kernel integration",
    "skills.test.ts": "Packaged Skill resources",
    "validate-recipe.scripts.test.ts": "Recipe validator script",
  };
  const owners = new Set(readdirSync(new URL("../lib/", import.meta.url)));
  const tests = readdirSync(new URL("./", import.meta.url)).filter(name => name.endsWith(".test.ts"));
  const unmirrored = tests.filter(name => !owners.has(name.replace(/\.test\.ts$/, ".ts"))).sort();
  assert.deepEqual(unmirrored, Object.keys(exceptions).sort(),
    "Consolidate contracts in their module owner; do not add an exception for another feature/case file");
  assert.ok(Object.values(exceptions).every(reason => reason.length > 0));
});

test("Standard validation isolates default agent state even when an operator directory is configured", async () => {
  const config = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const command of ["test", "test:preservation"]) assert.match(config.scripts[command], /--import \.\/tests\/test-environment\.mjs/);
  assert.match(await readFile(new URL("../scripts/conformance.mjs", import.meta.url), "utf8"), /"--import",\s*"\.\/tests\/test-environment\.mjs"/);
  const previous = process.env.PI_CODING_AGENT_DIR;
  const operator = join(tmpdir(), "operator-agent-must-not-be-used");
  process.env.PI_CODING_AGENT_DIR = operator;
  try {
    await import(new URL("./test-environment.mjs?isolation-invariant", import.meta.url).href);
    const isolated = process.env.PI_CODING_AGENT_DIR!;
    assert.notEqual(isolated, operator); assert.notEqual(isolated, previous);
    assert.ok(isolated.startsWith(join(tmpdir(), "pi-actors-test-agent-")));
    assert.equal(statSync(isolated).isDirectory(), true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

const indexSource = await readFile(
  new URL("../index.ts", import.meta.url),
  "utf8",
);
const extensionRuntimeSource = await readFile(
  new URL("../lib/extension-runtime.ts", import.meta.url),
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
const observabilitySource = await readFile(
  new URL("../lib/observability.ts", import.meta.url),
  "utf8",
);
const piSource = await readFile(
  new URL("../lib/pi.ts", import.meta.url),
  "utf8",
);
const runsTraceSource = await readFile(
  new URL("../lib/runs-trace.ts", import.meta.url),
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
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};
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
    source: await readFile(
      new URL(`../skills/recipe-memory/recipes/${name}`, import.meta.url),
      "utf8",
    ),
  })),
);

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

test("Entrypoint delegates tool and runtime composition", () => {
  assert.match(indexSource, /ExtensionRuntime\.createActorExtensionRuntime/);
  assert.match(indexSource, /runtime\.registerCoreTools\(\)/);
  assert.match(extensionRuntimeSource, /Tools\.createCoreActorToolDefinitions/);
  assert.match(toolsSource, /createRegisterToolDefinition/);
  assert.equal(indexSource.includes('name: "actors_tool_register"'), false);
});

test("Runtime reports recipe watcher failures", () => {
  assert.match(extensionRuntimeSource, /Runtime\.createRecipeToolReloadWatcher/);
  assert.match(runtimeSource, /Recipe live reload watcher failed/);
  assert.match(runtimeSource, /notifyFailure\(ctx\)/);
});

test("Session shutdown delegates captured-parent teardown through the run UI runtime", () => {
  assert.match(indexSource, /pi\.on\("session_shutdown"/);
  assert.match(indexSource, /runtime\.onSessionShutdown\(event\.reason, ctx\)/);
  assert.match(
    extensionRuntimeSource,
    /runUiRuntime\.shutdown\(reason, scope\.ownerId, ctx\)/,
  );
  assert.match(
    extensionRuntimeSource,
    /const known = parentSessionsByContext\.get\(ctx\)/,
  );
  assert.match(runUiRuntimeSource, /AsyncRuns\.teardownRunsOwnedByParent/);
  assert.match(runUiRuntimeSource, /session_shutdown:\$\{eventReason\}/);
});

test("Entrypoint waits for settled Pi lifecycle before automatic reviews", () => {
  assert.match(indexSource, /pi\.on\("agent_settled"/);
  assert.match(indexSource, /runtime\.onAgentSettled\(ctx\)/);
  assert.doesNotMatch(indexSource, /pi\.on\("agent_end"/);
  assert.match(extensionRuntimeSource, /onAgentSettled\(ctx\)/);
  assert.match(
    extensionRuntimeSource,
    /if \(!runUiRuntime\.flushCompletionBatch\(ctx\)\) automaticReview\.schedule\(\)/,
  );
});

test("Entrypoint delegates active completion boundaries without owning delivery policy", () => {
  assert.match(indexSource, /pi\.on\("turn_end", \(event, ctx\) => runtime\.onTurnEnd\(event, ctx\)\)/);
  assert.match(extensionRuntimeSource, /runUiRuntime\.onTurnEnd\(event, ctx\)/);
  assert.match(runUiRuntimeSource, /entries: \[\.\.\.event\.entries, entry\], continue: true/);
});

test("Entrypoint delegates model-bound completion presentation", () => {
  assert.match(indexSource, /pi\.on\("context"/);
  assert.match(indexSource, /runtime\.onContext\(event\.messages, ctx\)/);
  assert.match(extensionRuntimeSource, /runUiRuntime\.projectContext\(messages, ctx\)/);
  assert.match(runUiRuntimeSource, /markRunCompletionBatchPresented/);
  assert.doesNotMatch(runUiRuntimeSource, /deliverRunTransitionNotifications/);
  assert.doesNotMatch(observabilitySource, /deliverRunTransitionNotifications/);
});

test("Urgent steer remains explicit durable and safe-boundary delivered", () => {
  assert.match(runsTraceSource, /"notify" \| "followup" \| "steer"/);
  assert.match(piSource, /deliverAs: "steer"/);
  assert.match(runUiRuntimeSource, /admitRunSteerEnvelope/);
  assert.match(runUiRuntimeSource, /markRunSteerPresented/);
  assert.match(runUiRuntimeSource, /markRunSteerPresentationHandled/);
  assert.match(observabilitySource, /if \(event\.kind === "command\.done"\) return false/);
  assert.doesNotMatch(observabilitySource, /exit.*steer|steer.*exit/i);
});

test("Package requires the settled Pi host baseline", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-coding-agent": ">=1.0.0",
    "@earendil-works/pi-tui": ">=1.0.0",
  });
});

test("Entrypoint delegates low-level review and run lifecycle operations", () => {
  assert.match(extensionRuntimeSource, /AutomaticReviewRuntime\.createAutomaticReviewRuntime/);
  assert.match(extensionRuntimeSource, /RunUiRuntime\.createRunUiRuntime/);
  assert.doesNotMatch(indexSource, /AutomaticReviewRuntime|RunUiRuntime|ToolsResponse/);
  assert.doesNotMatch(indexSource, /AsyncRuns\.(?:startRun|listRuns|cancelRun|killRun)/);
  assert.doesNotMatch(indexSource, /create(?:DraftSleep|ToolReview)Scheduler/);
  assert.doesNotMatch(indexSource, /createRunStateWatcher|createRunTerminalReconciliationLoop/);
  assert.match(automaticReviewRuntimeSource, /DraftSleep\.createDraftSleepScheduler/);
  assert.match(automaticReviewRuntimeSource, /ToolReviewScheduler\.createToolReviewScheduler/);
});

test("Internal runtime input adapters use only Control terminology", () => {
  const sources = [
    indexSource,
    extensionRuntimeSource,
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

test("Recipe installation guidance excludes internal reviewers from bulk install", () => {
  const content = readFileSync("docs/recipe-library.md", "utf8");
  assert.doesNotMatch(content, /cp\s+[^\n]*recipes\/\*\.json/);
  assert.match(content, /Do not bulk-copy bundled Recipes/);
  assert.match(content, /`recipe-memory\/draft-review` and `recipe-memory\/tool-review`/);
  assert.match(content, /must not become user-installed callable tools/);
});

test("README first-run actor uses a shell-free command template", () => {
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /actors_run_spawn template="sleep 30" as=run:demo/);
  assert.doesNotMatch(readme, /actors_run_spawn template="[^"]*(?:&&|\|\||[|<>])[^"]*" as=run:demo/);
});

test("Public guidance preserves monotonic Run completion projection", () => {
  const readme = readFileSync("README.md", "utf8");
  const asyncRuns = readFileSync("docs/async-runs.md", "utf8");
  assert.match(readme, /Pi 1\.0\.0 or newer/);
  for (const content of [readme, asyncRuns]) {
    assert.match(content, /Generic command lifecycle is Trace-only/);
    assert.match(content, /completion scheduler/);
    assert.match(content, /model-bound (?:Pi )?context/);
    assert.match(content, /steer/);
    assert.match(content, /next safe (?:assistant\/tool )?boundary/);
    assert.doesNotMatch(content, /events\.command\.done\.delivery/);
  }
  assert.doesNotMatch(
    asyncRuns,
    /"kind":"command\.done"[^\n]*"attention"/,
  );
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

test("Platform-neutral validation executes every conformance assertion once through the full test profile", async () => {
  const validate = packageJson.scripts?.validate ?? "", fullTest = packageJson.scripts?.test ?? "";
  assert.equal(validate.split(/\s*&&\s*/u).filter((step: string) => step === "npm test").length, 1);
  assert.doesNotMatch(validate, /npm run conformance|npm audit/);
  const source = readFileSync("scripts/conformance.mjs", "utf8");
  const suitesMatch = /const conformanceSuites = (\[[\s\S]*?\]);/u.exec(source);
  assert.ok(suitesMatch);
  const suites: string[] = JSON.parse(suitesMatch[1].replace(/,\s*\]$/u, "]"));
  assert.ok(suites.length > 0); assert.equal(new Set(suites).size, suites.length);
  const profile = /process\.execPath,\s*(\[[\s\S]*?\]),\s*\{/u.exec(source);
  assert.ok(profile);
  const common = JSON.parse(profile[1].replace(/\.\.\.conformanceSuites,?\s*/u, "").replace(/,\s*\]$/u, "]"));
  const argv = fullTest.split(/\s+/u);
  assert.equal(argv[0], "node"); assert.equal(argv.at(-1), "tests/*.test.ts");
  assert.deepEqual(argv.slice(1, -1), common, "Conformance and full tests must keep identical preload/filter/concurrency flags");
  const discovered = globSync("*.test.ts", { cwd: "tests" }).sort();
  assert.deepEqual(discovered, readdirSync("tests").filter(name => name.endsWith(".test.ts")).sort());
  const allTests = new Set(discovered.map(name => "tests/" + name));
  const shardHelperUrl = new URL("../.github/scripts/test-shards.mjs", import.meta.url);
  const { SHARDS, TEST_FLAGS, partitionTests, parseArgs, testArgs } = await import(shardHelperUrl.href) as {
    SHARDS: string[]; TEST_FLAGS: string[];
    partitionTests(names: string[]): Record<string, string[]>;
    parseArgs(args: string[]): { shard: string; list: boolean };
    testArgs(names: string[]): string[];
  };
  assert.deepEqual(TEST_FLAGS, common);
  for (const shard of SHARDS) {
    const result = spawnSync(process.execPath, [".github/scripts/test-shards.mjs", shard, "--list"], { encoding: "utf8" });
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    const listing = JSON.parse(result.stdout);
    const selected = partitionTests(discovered)[shard];
    assert.deepEqual(listing, { shard, count: selected.length, files: selected.map(name => join("tests", name)) });
  }
  assert.equal(packageJson.scripts?.["test:shard"], "node .github/scripts/test-shards.mjs");
  for (const names of [discovered, [...discovered, "a synthetic 'quoted'.test.ts", "zz-new-owner.test.ts"]]) {
    const groups = partitionTests([...names].reverse());
    assert.deepEqual(groups.installed, ["installed.scripts.test.ts"]);
    const owners = names.filter(name => name !== "installed.scripts.test.ts").sort();
    assert.deepEqual(groups["owners-a"], owners.filter((_, index) => index % 2 === 0));
    assert.deepEqual(groups["owners-b"], owners.filter((_, index) => index % 2 === 1));
    const combined = SHARDS.flatMap(shard => groups[shard]);
    assert.equal(new Set(combined).size, names.length);
    assert.deepEqual(combined.sort(), [...names].sort());
    for (const shard of SHARDS) {
      assert.deepEqual(testArgs(groups[shard]), [...common, ...groups[shard].map(name => join("tests", name))]);
      assert.deepEqual(parseArgs([shard, "--list"]), { shard, list: true });
    }
  }
  for (const names of [[], ["installed.scripts.test.ts"], ["a.test.ts", "b.test.ts"], [...discovered, discovered[0]], [...discovered, "nested/file.test.ts"]]) {
    assert.throws(() => partitionTests(names));
  }
  for (const args of [[], ["unknown"], ["installed", "--test-name-pattern=x"], ["installed", "--list", "extra"]]) {
    assert.throws(() => parseArgs(args));
    const result = spawnSync(process.execPath, [".github/scripts/test-shards.mjs", ...args], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/); assert.equal(result.stdout, "");
  }
  const helper = readFileSync(".github/scripts/test-shards.mjs", "utf8");
  assert.match(helper, /spawn\(process\.execPath, testArgs\(selected\), \{ stdio: 'inherit', shell: false \}\)/);
  assert.match(helper, /process\.exitCode = code \?\? 1/);
  assert.doesNotMatch(helper, /--test-shard|--test-name|process\.exit\(|\.unref\(|setTimeout/);
  for (const suite of suites) assert.ok(allTests.has(suite), `Full validation must execute ${suite}`);
  assert.equal(packageJson.scripts?.conformance, "node scripts/conformance.mjs", "Standalone conformance remains available");
});

test("CI runs the dependency audit once on Ubuntu", () => {
  assert.equal(packageJson.scripts?.["audit:dependencies"], "npm audit --audit-level=high --omit=peer");
  assert.equal(validateWorkflowSource.match(/npm run audit:dependencies/g)?.length, 1);
  assert.match(validateWorkflowSource, /dependency-audit:[\s\S]*runs-on: ubuntu-latest/);
});

test("CI runs normal product validation without project-policy gates", async () => {
  assert.equal(packageJson.scripts?.["release:validate"], undefined);
  assert.equal(packageJson.scripts?.validate, "npm run validate:preflight && npm test && npm run pack:dry");
  assert.equal(packageJson.scripts?.["validate:preflight"], "npx tsc --noEmit && npm run recipes:qa && npm run build:check && npm run check");
  assert.match(validateWorkflowSource, /shard: \[installed, owners-a, owners-b\]/);
  assert.match(validateWorkflowSource, /name: Product validation \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.shard \}\}\)/);
  assert.match(validateWorkflowSource, /fail-fast: false/);
  assert.match(validateWorkflowSource, /timeout-minutes: \$\{\{ matrix\.os == 'windows-latest' && 60 \|\| 20 \}\}/);
  for (const command of ["validate:preflight", "pack:dry"]) {
    assert.equal(validateWorkflowSource.split(`run: npm run ${command}`).length - 1, 1);
    assert.ok(validateWorkflowSource.includes(`if: matrix.shard == 'installed'\n        run: npm run ${command}`));
  }
  assert.match(validateWorkflowSource, /run: npm run test:shard -- \$\{\{ matrix\.shard \}\}/);
  assert.match(validateWorkflowSource, /PI_ACTORS_WINDOWS_BOUNDARY_TIMING: \$\{\{ matrix\.os == 'windows-latest' && '1' \|\| '0' \}\}/);
  assert.doesNotMatch(validateWorkflowSource, /continue-on-error|always\(\)|cancel-in-progress|run: npm run validate\s*\n/);
  assert.doesNotMatch(validateWorkflowSource, /release:validate|release-gates|domain-dag/);
  assert.doesNotMatch(releaseWorkflowSource, /release:validate|release-gates|domain-dag/);
  for (const runner of ["ubuntu-latest", "macos-latest", "windows-latest"]) assert.ok(validateWorkflowSource.includes("- " + runner), runner);
  const installed = await readFile(new URL("./installed.scripts.test.ts", import.meta.url), "utf8");
  const native = installed.split('test("source and packed default SDK shutdown')[1]?.split('\ntest("')[0];
  assert.ok(native, "The actual source/npm native shutdown journey must remain in product validation");
  assert.match(installed, /timeout: process\.platform === "win32" \? 900_000 : 300_000/);
  const supported = native.match(/skip:\s*!\[([^\]]+)\]\.includes\(process\.platform\)/)?.[1];
  assert.ok(supported, "Native shutdown must not be Linux-only skipped on the declared CI platforms");
  assert.deepEqual(JSON.parse("[" + supported + "]").sort(), ["darwin", "linux", "win32"]);
});

test("CI workflows use reusable validation and Node 24 action runtimes", () => {
  const triggers = validateWorkflowSource.match(/^on:\n([\s\S]*?)(?=^\S)/mu)?.[1];
  assert.ok(triggers, "Validation must declare its explicit trigger block");
  assert.deepEqual([...triggers.matchAll(/^  ([a-z_]+):/gmu)].map(match => match[1]).sort(), ["pull_request", "workflow_call"],
    "Ordinary CI runs only on PRs; release reuse must not create standalone push/tag runs");
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
  assert.match(publishJob, /timeout-minutes: 11/);
  assert.match(publishJob, /verification_deadline=\$\(\(SECONDS \+ 600\)\)/);
  assert.match(publishJob, /timeout --kill-after=5s "\$\{remaining\}s" npm/);
  assert.match(publishJob, /npm_within_deadline view[\s\S]*&&\n\s*npm_within_deadline pack[\s\S]*; then\n\s*node --input-type=module/);
  assert.match(publishJob, /pack "\$PACKAGE_NAME@\$VERSION" --prefer-online --dry-run --json/);
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

test("Music player helper uses only Control and Trace state", () => {
  const script = readFileSync("skills/music-player/scripts/playback.mjs", "utf8");
  assert.match(script, /controls\.jsonl/);
  assert.match(script, /control-endpoint\.json/);
  assert.doesNotMatch(script, /inbox\.jsonl|outbox\.jsonl|message to=|player\.<command>/);
});

test("First-party scripts use only canonical Trace and Control journals", () => {
  const directTraceWrite = /(?:appendFileSync|writeFileSync|writeText(?:Atomic)?)\s*\(\s*[A-Za-z0-9_.]*?(?:trace|event)(?:Path|File)/iu;
  for (const file of [
    "scripts/async-runner.mjs",
    "skills/actors/scripts/resource-locker.mjs",
    "skills/music-player/scripts/playback.mjs",
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
});

test("Async runner admits and publishes natural results through the lifecycle owner", () => {
  const script = readFileSync("scripts/async-runner.mjs", "utf8");
  assert.match(script, /importRuntimeModule\("runs-results"\)/);
  assert.match(script, /admitRunResultProducer\(stateDir\)/);
  assert.match(script, /publishRunResult\(stateDir, producer,/);
  assert.doesNotMatch(script, /(?:writeJsonAtomic|writeFileSync|appendFileSync)\(\s*resultPath/u);
});

test("Music player helper keeps player processes inside the run process group", () => {
  const script = readFileSync("skills/music-player/scripts/playback.mjs", "utf8");
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
  const recipe = JSON.parse(readFileSync("skills/music-player/recipes/playback.json", "utf8"));
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
  const script = readFileSync("skills/music-player/scripts/playback.mjs", "utf8");
  const usagePlayers = script
    .match(/Supported players: (?<values>[^.]+)\./)
    ?.groups?.values.split(", ");
  assert.deepEqual(usagePlayers, recipePlayers);
});
