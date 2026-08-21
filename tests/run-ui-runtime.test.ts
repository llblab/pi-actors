import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-run-ui-runtime-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutomaticReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";

const { createActorExtensionRuntime } = await import("../lib/extension-runtime.ts");
const { createRunUiRuntime } = await import("../lib/run-ui-runtime.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousAutomaticReview === undefined) {
    delete process.env.PI_ACTORS_AUTOMATIC_REVIEW;
  } else {
    process.env.PI_ACTORS_AUTOMATIC_REVIEW = previousAutomaticReview;
  }
  await rm(agentDir, { force: true, recursive: true });
});

function staleContext(sessionId = "session-a") {
  let stale = false;
  let statusCalls = 0;
  const ui = {
    notify: () => undefined,
    setStatus: () => {
      statusCalls += 1;
    },
    setWidget: () => undefined,
    theme: { fg: (_tone: string, value: string) => value },
  };
  const context = {
    cwd: agentDir,
    get sessionManager() {
      if (stale) throw new Error("stale sessionManager");
      return { getSessionId: () => sessionId };
    },
    get ui() {
      if (stale) throw new Error("stale ui");
      return ui;
    },
  } as any;
  return {
    context,
    makeStale: () => {
      stale = true;
    },
    statusCalls: () => statusCalls,
  };
}

function runtimeHarness(options: {
  animationIntervalMs?: number;
  notificationDelayMs?: number;
  teardownFailed?: boolean;
} = {}) {
  let activeContext: any;
  let callbackErrors = 0;
  let watcherCloseCalls = 0;
  let watcherOnChange: (() => void) | undefined;
  let reconciliationInput: any;
  let teardownInput: { ownerId?: string; trigger?: string } = {};
  const runtime = createRunUiRuntime({
    animationIntervalMs: options.animationIntervalMs ?? 10_000,
    createRunStateWatcher: ((input: any) => {
      watcherOnChange = input.onChange;
      return {
        close: () => {
          watcherCloseCalls += 1;
        },
        getDiagnostics: () => [],
        refresh: () => undefined,
      };
    }) as any,
    createRunTerminalReconciliationLoop: ((input: any) => {
      reconciliationInput = input;
      return {
        close: () => undefined,
        reconcileNow: () => {
          try {
            input.refreshWatcher();
            input.reconcile();
          } catch (error) {
            input.onError?.(error);
          }
        },
        start: () => undefined,
      };
    }) as any,
    getActiveContext: () => activeContext,
    notificationDelayMs: options.notificationDelayMs ?? 5,
    onCallbackError: () => {
      callbackErrors += 1;
    },
    onRunEvent: () => undefined,
    pi: { sendMessage: () => undefined } as any,
    teardownRunsOwnedByParent: ((ownerId: string, _root: string, input: any) => {
      teardownInput = { ownerId, trigger: input.trigger };
      return {
        attempted: 0,
        attempts: [],
        discoveryFailed: 0,
        discoveryFailures: [],
        failed: options.teardownFailed ? 1 : 0,
        killed: 0,
        skipped: 0,
      };
    }) as any,
  });
  return {
    callbackErrors: () => callbackErrors,
    reconciliationInput: () => reconciliationInput,
    runtime,
    setActiveContext: (ctx: any) => {
      activeContext = ctx;
    },
    teardownInput: () => teardownInput,
    watcherCloseCalls: () => watcherCloseCalls,
    watcherOnChange: () => watcherOnChange,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("stale animation ticks stop the Run UI runtime without escaping", async () => {
  const stale = staleContext();
  const harness = runtimeHarness({ animationIntervalMs: 5 });
  harness.setActiveContext(stale.context);
  harness.runtime.start(stale.context, "session-a");
  assert.equal(stale.statusCalls(), 1);

  stale.makeStale();
  await delay(25);
  const callsAfterFailure = stale.statusCalls();
  await delay(15);

  assert.equal(callsAfterFailure, 1);
  assert.equal(stale.statusCalls(), 1);
  assert.equal(harness.watcherCloseCalls() >= 2, true);
  assert.equal(harness.callbackErrors(), 1);
  harness.runtime.close();
});

test("stale delayed watcher updates and reconciliation callbacks fail closed", async () => {
  const watcherStale = staleContext();
  const watcherHarness = runtimeHarness({ notificationDelayMs: 5 });
  watcherHarness.setActiveContext(watcherStale.context);
  watcherHarness.runtime.start(watcherStale.context, "session-a");
  watcherHarness.watcherOnChange()!();
  watcherStale.makeStale();
  await delay(20);
  assert.equal(watcherHarness.watcherCloseCalls() >= 2, true);

  const reconciliationStale = staleContext();
  const reconciliationHarness = runtimeHarness();
  reconciliationHarness.setActiveContext(reconciliationStale.context);
  reconciliationHarness.runtime.start(reconciliationStale.context, "session-a");
  reconciliationStale.makeStale();
  assert.doesNotThrow(() =>
    reconciliationHarness.reconciliationInput().onError(
      new Error("reconciliation failed"),
    ),
  );
  assert.equal(reconciliationHarness.watcherCloseCalls() >= 2, true);
  reconciliationHarness.runtime.close();
});

test("shutdown uses captured owner identity and stale UI notification is no-throw", () => {
  const stale = staleContext();
  const harness = runtimeHarness({ teardownFailed: true });
  harness.setActiveContext(stale.context);
  harness.runtime.start(stale.context, "session-a");
  stale.makeStale();

  assert.doesNotThrow(() =>
    harness.runtime.shutdown("quit", "session-a", stale.context),
  );
  assert.deepEqual(harness.teardownInput(), {
    ownerId: "session-a",
    trigger: "session_shutdown:quit",
  });
  assert.doesNotThrow(() => harness.runtime.close());
});

test("a delayed old-session shutdown cannot close the replacement runtime", async () => {
  const definitions = new Map<string, any>();
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [...definitions.keys()],
    getAllTools: () => [...definitions.values()],
    getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition),
    sendMessage: () => undefined,
    setActiveTools: () => undefined,
  } as never);
  const alpha = staleContext("session-alpha");
  const beta = staleContext("session-beta");
  await extension.onSessionStart(alpha.context);
  await extension.onSessionStart(beta.context);
  const betaStatusCalls = beta.statusCalls();
  alpha.makeStale();

  assert.doesNotThrow(() => extension.onSessionShutdown("quit", alpha.context));
  await delay(1_050);
  assert.equal(beta.statusCalls() > betaStatusCalls, true);
  extension.onSessionShutdown("quit", beta.context);
});

test("extension shutdown never re-reads an invalidated context", async () => {
  const definitions = new Map<string, any>();
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [...definitions.keys()],
    getAllTools: () => [...definitions.values()],
    getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition),
    sendMessage: () => undefined,
    setActiveTools: () => undefined,
  } as never);
  const stale = staleContext();
  await extension.onSessionStart(stale.context);
  stale.makeStale();

  assert.doesNotThrow(() => extension.onSessionShutdown("quit", stale.context));
});
