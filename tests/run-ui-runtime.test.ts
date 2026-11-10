import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDocument } from "yaml";

import * as Limits from "../lib/limits.ts";
import { renderYamlMetadata } from "../lib/tools-response.ts";

/** Expected bare block-YAML notice text: no leading LF, no trailing LF. */
function noticeDocument(value: Record<string, unknown>): string {
  const rendered = renderYamlMetadata(value, Limits.RUN_DELIVERY_MODEL_MAX_BYTES);
  assert.equal(rendered.state, "available");
  return (rendered as { text: string }).text.replace(/\n$/u, "");
}

function freshCoreHeaders(text: string): any[] {
  const rows: any[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const framed = text.startsWith("---\n", cursor), start = cursor + (framed ? 4 : 0);
    const end = text.indexOf(framed ? "\n---\n" : "\n\n", start);
    assert.ok(!framed || end >= start);
    const doc = parseDocument(text.slice(start, end < 0 ? text.length : end), { uniqueKeys: true });
    assert.deepEqual(doc.errors, []);
    const row = doc.toJS(); rows.push(row);
    cursor = end < 0 ? text.length : end + (framed ? 5 : 2);
    for (const part of row._completion?.parts ?? []) {
      const length = part.body ?? part.marker; assert.ok(Number.isSafeInteger(length) && length >= 0); cursor += length;
    }
    if (framed && cursor < text.length) { assert.equal(text.slice(cursor, cursor + 2), "\n\n"); cursor += 2; }
  }
  return rows;
}
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const agentDir = await mkdtemp(join(tmpdir(), "pi-actors-run-ui-runtime-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAutomaticReview = process.env.PI_ACTORS_AUTOMATIC_REVIEW;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_ACTORS_AUTOMATIC_REVIEW = "off";

const { createActorExtensionRuntime } = await import("../lib/extension-runtime.ts");
const { createRunUiRuntime, registerRunCompletionRenderer } = await import("../lib/run-ui-runtime.ts");
const {
  admitRunCompletionBatch,
  captureRunCompletionYamlCandidateBatch,
  requestRunCompletionStream,
  finalizeRunCompletionBatch,
  admitRunSteerEnvelope,
  formatRunCompletionBatchMessage,
  projectRunCompletionBatchPresentation,
  getRunDeliveryJournalPath,
  markRunCompletionBatchQueued,
  markRunCompletionBatchPresented,
  markRunSteerQueued,
  markRunSteerPresented,
  readRunDeliveryJournal,
} = await import("../lib/run-delivery.ts");
const { claimRunStateDirectory } = await import("../lib/runs-ownership.ts");
const { appendRunTraceEvent, readRunTraceEvents } = await import("../lib/runs-trace.ts");

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
  const notifications: Array<{ level: string; message: string }> = [];
  let sessionLeaf: Record<string, unknown> | undefined;
  const sessionEntries = new Map<string, Record<string, unknown>>();
  const ui = {
    notify: (message: string, level: string) => {
      notifications.push({ level, message });
    },
    setStatus: () => {
      statusCalls += 1;
    },
    setWidget: () => undefined,
    theme: { fg: (_tone: string, value: string) => value },
  };
  const sessionManager = {
    getEntry: (id: string) => sessionEntries.get(id),
    getLeafEntry: () => sessionLeaf,
    getSessionId: () => sessionId,
  };
  const context = {
    cwd: agentDir,
    get sessionManager() {
      if (stale) throw new Error("stale sessionManager");
      return sessionManager;
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
    notifications: () => notifications,
    setSessionBranch: (entries: Record<string, unknown>[]) => {
      sessionEntries.clear();
      for (const entry of entries) sessionEntries.set(String(entry.id), entry);
      sessionLeaf = entries.at(-1);
    },
    statusCalls: () => statusCalls,
  };
}

function runtimeHarness(options: {
  animationIntervalMs?: number;
  deliveryDebounceMs?: number;
  notificationDelayMs?: number;
  sendFailures?: number;
  sendError?: Error;
  onSend?: () => void;
  teardownFailed?: boolean;
  summaryPath?: string;
  completionStreamSessionAdmission?: Parameters<typeof createRunUiRuntime>[0]["completionStreamSessionAdmission"];
  captureCompletionBatch?: Parameters<typeof createRunUiRuntime>[0]["captureCompletionBatch"];
} = {}) {
  let activeContext: any;
  let callbackErrors = 0;
  const callbackFailures: unknown[] = [];
  let watcherCloseCalls = 0;
  let watcherOnChange: (() => void) | undefined;
  let reconciliationInput: any;
  let sendAttempts = 0;
  const sentMessages: Array<{ message: any; options: any }> = [];
  let teardownInput: { ownerId?: string; trigger?: string } = {};
  const runtime = createRunUiRuntime({
    completionStreamSessionAdmission: options.completionStreamSessionAdmission,
    captureCompletionBatch: options.captureCompletionBatch,
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
    deliveryDebounceMs: options.deliveryDebounceMs ?? 5,
    getActiveContext: () => activeContext,
    notificationDelayMs: options.notificationDelayMs ?? 5,
    onCallbackError: (error) => {
      callbackErrors += 1;
      callbackFailures.push(error);
    },
    onRunEvent: () => undefined,
    pi: {
      sendMessage: (message: any, sendOptions: any) => {
        sendAttempts += 1;
        if (sendAttempts <= (options.sendFailures ?? 0)) {
          throw options.sendError ?? new Error("simulated completion send failure");
        }
        sentMessages.push({ message, options: sendOptions });
        options.onSend?.();
      },
    } as any,
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
        ...(options.summaryPath ? { summaryPath: options.summaryPath } : {}),
      };
    }) as any,
  });
  return {
    callbackErrors: () => callbackErrors,
    callbackFailures: () => callbackFailures,
    reconciliationInput: () => reconciliationInput,
    runtime,
    sendAttempts: () => sendAttempts,
    sentMessages: () => sentMessages,
    setActiveContext: (ctx: any) => {
      activeContext = ctx;
    },
    teardownInput: () => teardownInput,
    watcherCloseCalls: () => watcherCloseCalls,
    watcherOnChange: () => watcherOnChange,
  };
}

test("Candidate private composition binds manager lifetimes independently of stream activation", () => {
  assert.throws(() => runtimeHarness({ captureCompletionBatch: captureRunCompletionYamlCandidateBatch,
    completionStreamSessionAdmission: () => { assert.fail("Candidate must not invoke stream admission"); } }), /cannot use completion streams/u);
  const harness = runtimeHarness({ captureCompletionBatch: captureRunCompletionYamlCandidateBatch });
  const first = staleContext("candidate-epoch"), replacement = staleContext("candidate-epoch");
  try {
    harness.setActiveContext(first.context);
    harness.runtime.start(first.context, "candidate-epoch");
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), true);
    assert.equal(harness.runtime.isCurrentSessionContext(replacement.context), false);
    const wrapper = { ...first.context };
    assert.equal(harness.runtime.isCurrentSessionContext(wrapper), true);
    harness.setActiveContext(replacement.context);
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
    harness.runtime.start(replacement.context, "candidate-epoch");
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(replacement.context), true);
    harness.setActiveContext(first.context);
    harness.runtime.start(first.context, "candidate-epoch");
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(wrapper), false);
    assert.equal(harness.runtime.isCurrentSessionContext({ ...first.context }), false);
  } finally { harness.runtime.close(); }
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const extensionTempDir = join(agentDir, "tmp", "pi-actors");

async function writeTerminalRun(
  ownerId: string,
  run: string,
  runInstanceId: string,
  lineage?: {
    deliveryOwnerId: string;
    parent?: { run: string; runInstanceId: string; stateDir: string };
  },
): Promise<string> {
  const stateDir = join(extensionTempDir, "runs", run);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "run.json"), JSON.stringify({
    createdAt: "2026-09-01T12:00:00.000Z",
    cwd: agentDir,
    ...(lineage
      ? {
          delivery_owner_id: lineage.deliveryOwnerId,
          ...(lineage.parent
            ? {
                delivery_parent: {
                  run: lineage.parent.run,
                  run_instance_id: lineage.parent.runInstanceId,
                  state_dir: lineage.parent.stateDir,
                },
              }
            : {}),
        }
      : {}),
    ownerId,
    pid: 999_999_999,
    run,
    run_instance_id: runInstanceId,
    state_dir: stateDir,
  }));
  await writeFile(join(stateDir, "progress.json"), JSON.stringify({
    completed: 1,
    failures: [],
    updatedAt: "2026-09-01T12:01:00.000Z",
  }));
  await writeFile(join(stateDir, "result.json"), JSON.stringify({
    code: 0,
    completed_at: "2026-09-01T12:01:00.000Z",
  }));
  await rm(join(stateDir, "terminal-handled.json"), { force: true });
  return stateDir;
}

test("Candidate epoch property: only pinned lifetimes capture or ACK; saved packets replay as data", async (t) => {
  for (const scenario of ["context", "send", "recovery", "observation", "capture-return"] as const) {
    await t.test(scenario, async () => {
      const ownerId = `candidate-temporal-${scenario}`, generation = `generation-${scenario}`;
      const first = staleContext(ownerId), fresh = staleContext(ownerId);
      first.context.isIdle = fresh.context.isIdle = () => false;
      const directory = await writeTerminalRun(ownerId, `candidate-temporal-${scenario}`, generation);
      let harness: ReturnType<typeof runtimeHarness>;
      const replace = () => { harness.setActiveContext(fresh.context); harness.runtime.start(fresh.context, ownerId); };
      harness = runtimeHarness({
        captureCompletionBatch: scenario === "capture-return" ? ((...args) => {
          const captured = captureRunCompletionYamlCandidateBatch(...args);
          replace();
          return captured;
        }) : captureRunCompletionYamlCandidateBatch,
        onSend: scenario === "send" ? replace : undefined,
      });
      harness.setActiveContext(first.context); harness.runtime.start(first.context, ownerId);
      const pending = () => readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch;
      const unhandled = () => assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
      const held = () => { assert.equal(pending()!.phase, "pending"); unhandled(); };
      const handled = () => {
        assert.equal(pending(), undefined);
        assert.equal(JSON.parse(fs.readFileSync(join(directory, "terminal-handled.json"), "utf8")).run_instance_id, generation);
      };
      try {
        if (scenario === "observation") {
          const read = fs.readFileSync, descriptor = Object.getOwnPropertyDescriptor(fs, "readFileSync")!;
          let intercepted = 0;
          fs.readFileSync = ((path, ...args) => {
            if (String(path) === join(directory, "result.json") && intercepted++ === 0) replace();
            return Reflect.apply(read, fs, [path, ...args]);
          }) as typeof fs.readFileSync;
          syncBuiltinESMExports();
          try { assert.equal(harness.runtime.onTurnEnd(completedBoundary(), first.context), undefined); }
          finally { Object.defineProperty(fs, "readFileSync", descriptor); syncBuiltinESMExports(); }
          assert.ok(intercepted > 0); assert.equal(pending(), undefined); unhandled();
          assert.equal(harness.sendAttempts(), 0);
          return;
        }
        const proposal = harness.runtime.onTurnEnd(completedBoundary(), first.context);
        assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_stream, undefined);
        assert.equal(pending()!.result_layout, "completion_yaml_core_v1");
        held();
        if (scenario === "capture-return") {
          assert.equal(proposal, undefined); assert.equal(harness.sendAttempts(), 0);
          assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
          return;
        }
        const entry = proposal!.entries![0] as any;
        if (scenario === "context") {
          assert.equal(harness.runtime.onTurnEnd(completedBoundary(), fresh.context), undefined);
          const wrong = [{ ...entry, content: entry.content + "\nwrong full content" }];
          assert.equal(harness.runtime.projectContext(wrong, first.context).length, 0); held();
          const wrapper = { ...first.context };
          assert.equal(harness.runtime.isCurrentSessionContext(wrapper), true);
          harness.runtime.projectContext([entry], wrapper); handled();
        } else if (scenario === "send") {
          const oldWatcher = harness.watcherOnChange()!, oldLoop = harness.reconciliationInput();
          first.context.isIdle = () => true;
          assert.equal(harness.runtime.flushCompletionBatch(first.context), true);
          assert.equal(harness.sentMessages().length, 1, "Transport effect survives epoch revocation"); held();
          harness.runtime.projectContext([entry], first.context); held();
          const closes = harness.watcherCloseCalls();
          oldWatcher(); oldLoop.refreshWatcher(); oldLoop.reconcile(); oldLoop.onError(new Error("retired callback"));
          assert.equal(harness.watcherCloseCalls(), closes);
          assert.equal(harness.runtime.isCurrentSessionContext(fresh.context), true); held();
          harness.runtime.projectContext([entry], fresh.context); handled();
          harness.setActiveContext(first.context); harness.runtime.start(first.context, ownerId);
          assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
        } else {
          for (const entries of [
            [{ type: "custom", id: "missing", parentId: "absent" }],
            [{ ...entry, content: entry.content + "\nconflict", id: "conflict", parentId: null }],
          ]) {
            first.setSessionBranch(entries);
            assert.equal(harness.runtime.onTurnEnd(completedBoundary(), first.context), undefined); held();
          }
          first.setSessionBranch([{ ...entry, id: "exact", parentId: null }]);
          const leaf = first.context.sessionManager.getLeafEntry;
          first.context.sessionManager.getLeafEntry = () => { const value = leaf(); replace(); return value; };
          assert.equal(harness.runtime.onTurnEnd(completedBoundary(), first.context), undefined); held();
          fresh.setSessionBranch([{ ...entry, id: "exact", parentId: null }]);
          assert.equal(harness.runtime.onTurnEnd(completedBoundary(), fresh.context), undefined);
          handled(); assert.equal(harness.sendAttempts(), 0);
        }
      } finally { harness.runtime.close(); }
    });
  }
});

test("Candidate generation property: captured data cannot handle a replacement generation", async () => {
  const ownerId = "candidate-generation-replacement", run = "candidate-generation-run";
  const oldGeneration = "candidate-generation-old", newGeneration = "candidate-generation-new";
  const active = staleContext(ownerId); active.context.isIdle = () => false;
  claimRunStateDirectory(join(extensionTempDir, "runs", run), run);
  const directory = await writeTerminalRun(ownerId, run, oldGeneration);
  const harness = runtimeHarness({ captureCompletionBatch: captureRunCompletionYamlCandidateBatch });
  harness.setActiveContext(active.context); harness.runtime.start(active.context, ownerId);
  try {
    const entry = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
    const captured = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    assert.equal(captured.result_layout, "completion_yaml_core_v1");
    assert.equal(captured.members[0].run_instance_id, oldGeneration);
    await writeTerminalRun(ownerId, run, newGeneration);
    assert.equal(JSON.parse(await readFile(join(directory, "run.json"), "utf8")).run_instance_id, newGeneration);
    assert.equal(harness.runtime.isCurrentSessionContext(active.context), true);
    assert.equal(harness.runtime.projectContext([entry], active.context).length, 1);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
    const fresh = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
    const replacement = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    assert.equal(replacement.members.length, 1);
    assert.equal(replacement.members[0].run_instance_id, newGeneration);
    assert.notEqual(replacement.batch_id, captured.batch_id);
    harness.runtime.projectContext([fresh], active.context);
    assert.equal(JSON.parse(await readFile(join(directory, "terminal-handled.json"), "utf8")).run_instance_id, newGeneration);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(harness.sendAttempts(), 0);
  } finally { harness.runtime.close(); }
});

test("Candidate throw property: reentrant same-ID replacement revokes the throwing sender", async () => {
  const ownerId = "candidate-send-throw", generation = "candidate-send-throw-generation";
  const first = staleContext(ownerId), fresh = staleContext(ownerId);
  first.context.isIdle = fresh.context.isIdle = () => false;
  const directory = await writeTerminalRun(ownerId, ownerId, generation);
  const sentinel = new Error("candidate reentrant send sentinel");
  let intercepted = 0;
  const harness = runtimeHarness({ captureCompletionBatch: captureRunCompletionYamlCandidateBatch,
    onSend: () => {
      intercepted++;
      harness.setActiveContext(fresh.context); harness.runtime.start(fresh.context, ownerId);
      throw sentinel;
    } });
  harness.setActiveContext(first.context); harness.runtime.start(first.context, ownerId);
  try {
    const entry = harness.runtime.onTurnEnd(completedBoundary(), first.context)!.entries![0] as any;
    const captured = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    const oldWatcher = harness.watcherOnChange()!, oldLoop = harness.reconciliationInput();
    first.context.isIdle = () => true;
    assert.throws(() => harness.runtime.flushCompletionBatch(first.context), error => error === sentinel);
    assert.equal(intercepted, 1); assert.equal(harness.sendAttempts(), 1);
    assert.equal(harness.sentMessages().length, 1, "Private port invocation is not SDK/network delivery proof");
    assert.deepEqual(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, captured);
    assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(fresh.context), true);
    const closes = harness.watcherCloseCalls();
    oldWatcher(); oldLoop.refreshWatcher(); oldLoop.reconcile(); oldLoop.onError(sentinel);
    harness.runtime.projectContext([entry], first.context);
    assert.equal(harness.watcherCloseCalls(), closes); assert.equal(harness.callbackErrors(), 0);
    assert.equal(harness.runtime.isCurrentSessionContext(fresh.context), true);
    assert.deepEqual(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, captured);
    assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
    harness.runtime.projectContext([entry], fresh.context);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(JSON.parse(await readFile(join(directory, "terminal-handled.json"), "utf8")).run_instance_id, generation);
    assert.equal(harness.sendAttempts(), 1);
  } finally { harness.runtime.close(); }
});

test("Candidate composition property: same-ID manager replacement during reached location observation refuses capture", async () => {
  const ownerId = "candidate-location-manager", generation = "candidate-location-generation";
  const first = staleContext(ownerId), replacement = staleContext(ownerId);
  first.context.isIdle = replacement.context.isIdle = () => false;
  claimRunStateDirectory(join(extensionTempDir, "runs", ownerId), ownerId);
  const directory = await writeTerminalRun(ownerId, ownerId, generation);
  let captures = 0, observations = 0;
  const harness = runtimeHarness({ captureCompletionBatch: (...args) => {
    captures++; return captureRunCompletionYamlCandidateBatch(...args);
  } });
  harness.setActiveContext(first.context); harness.runtime.start(first.context, ownerId);
  const descriptor = Object.getOwnPropertyDescriptor(fs, "lstatSync")!, lstat = fs.lstatSync;
  fs.lstatSync = ((path, ...args) => {
    if (String(path) === join(directory, "stdout.log") && observations++ === 0) {
      harness.setActiveContext(replacement.context); harness.runtime.start(replacement.context, ownerId);
    }
    return Reflect.apply(lstat, fs, [path, ...args]);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try {
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), first.context), undefined);
    assert.ok(observations > 0, "Actual Run-directory role observation was reached");
    assert.equal(first.context.sessionManager.getSessionId(), replacement.context.sessionManager.getSessionId());
    assert.notEqual(first.context.sessionManager, replacement.context.sessionManager);
    assert.equal(harness.runtime.isCurrentSessionContext(first.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(replacement.context), true);
    assert.equal(captures, 0); assert.equal(harness.sendAttempts(), 0);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
  } finally {
    Object.defineProperty(fs, "lstatSync", descriptor); syncBuiltinESMExports(); harness.runtime.close();
  }
});

test("Candidate composition property: private extension port and passive supervision follow awaited manager lifetime", async () => {
  const ownerId = "candidate-extension-manager", first = staleContext(ownerId), replacement = staleContext(ownerId);
  first.context.isIdle = replacement.context.isIdle = () => false;
  const sent: any[] = [];
  let captures = 0, scheduled = 0, due = 0;
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
    registerTool: () => undefined, registerMessageRenderer: () => undefined, setActiveTools: () => undefined,
    sendMessage: (message: any) => { sent.push(message); },
  } as never, { schedule: () => { scheduled++; return () => undefined; }, onDeadlineDue: () => { due++; } },
  undefined, (...args) => { captures++; return captureRunCompletionYamlCandidateBatch(...args); });
  try {
    await extension.onSessionStart(first.context);
    const oldObserver = extension.getRunAdmissionObserver(first.context)!;
    const directory = await writeTerminalRun(ownerId, ownerId, "candidate-extension-generation");
    const entry = extension.onTurnEnd(completedBoundary(), first.context)!.entries![0] as any;
    const pending = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    assert.equal(captures, 1); assert.equal(pending.result_layout, "completion_yaml_core_v1");
    await extension.onSessionStart(replacement.context);
    const wrapper = { ...replacement.context, isIdle: () => true };
    const currentObserver = extension.getRunAdmissionObserver(wrapper)!;
    assert.equal(typeof currentObserver, "function");
    assert.throws(() => oldObserver(undefined as never), /admission is unavailable or changed/u);
    first.context.isIdle = () => true;
    first.makeStale();
    assert.doesNotThrow(() => extension.onAgentSettled(first.context));
    extension.onAgentSettled(staleContext(ownerId).context);
    extension.onSessionShutdown("quit", first.context);
    extension.onSessionShutdown("quit", staleContext(ownerId).context);
    assert.equal(sent.length, 0);
    assert.deepEqual(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, pending);
    assert.equal(fs.existsSync(join(directory, "terminal-handled.json")), false);
    extension.onAgentSettled(wrapper);
    assert.equal(sent.length, 1, "Fresh wrapper sharing the actual replacement manager may flush");
    assert.equal(sent[0].content, entry.content); assert.equal(captures, 1);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(JSON.parse(await readFile(join(directory, "terminal-handled.json"), "utf8")).run_instance_id, "candidate-extension-generation");
    assert.deepEqual(extension.observeRunSnapshot({ run: ownerId, run_instance_id: "candidate-extension-generation", ownerId }, "2026-09-01T12:01:00.000Z"), { state: "unavailable", reason: "origin_not_retained" });
    const before = teardownReports();
    extension.onSessionShutdown("quit", wrapper);
    const report = teardownReports().filter(item => !before.some(old => old.file === item.file));
    assert.equal(report.length, 1); assert.equal(report[0].ownerId, ownerId); assert.equal(report[0].attempted, 0);
    assert.throws(() => currentObserver(undefined as never), /admission is unavailable or changed/u);
    extension.onAgentSettled(wrapper); extension.onContext([entry], wrapper);
    extension.onSessionShutdown("quit", wrapper);
    assert.equal(teardownReports().length, before.length + 1);
    assert.equal(sent.length, 1); assert.equal(scheduled, 0); assert.equal(due, 0);
  } finally { extension.onSessionShutdown("quit", replacement.context); }
});

test("Notifying update projects once before UI callbacks and completion flush observes afresh", async (t) => {
  const ownerId = "shared-observation-callback", active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const stateDir = await writeTerminalRun(ownerId, "shared-observation-run", "shared-observation-generation");
  const metaPath = join(stateDir, "run.json"), resultPath = join(stateDir, "result.json");
  const syntheticPid = 21_111_111;
  fs.writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaPath, "utf8")), pid: syntheticPid }));
  fs.unlinkSync(resultPath);
  const exists = fs.existsSync, kill = process.kill;
  let probes = 0, callbackProbes = 0;
  const existsHook = t.mock.method(fs, "existsSync", (path: fs.PathLike) => String(path) === "/proc" ? false : exists(path));
  const probeHook = t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
    if (args[0] === syntheticPid) { probes++; return true; } // Synthetic metadata only; no process was born.
    return Reflect.apply(kill, process, args);
  });
  syncBuiltinESMExports();
  active.context.ui.setStatus = () => {
    callbackProbes = probes;
    fs.writeFileSync(resultPath, JSON.stringify({ code: 0, completed_at: "2026-09-01T12:01:00.000Z" }));
  };
  const harness = runtimeHarness(); harness.setActiveContext(active.context);
  try {
    harness.runtime.start(active.context, ownerId);
    assert.equal(callbackProbes, 2, "One startup prime plus one shared update, before setStatus");
    assert.equal(probes, 2, "No delayed second observation after the UI callback");
    assert.equal(harness.runtime.flushCompletionBatch(active.context), true);
    assert.ok(probes > 2, "Flush must independently reobserve after the callback, not capture the earlier frame");
    const batch = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch;
    assert.equal(batch?.members.find(member => member.run === "shared-observation-run")?.status, "done");
  } finally { harness.runtime.close(); existsHook.mock.restore(); probeHook.mock.restore(); syncBuiltinESMExports(); await rm(stateDir, { recursive: true, force: true }); }
});

function seedStreamJournal(ownerId: string) {
  const input = { tempDir: extensionTempDir, ownerId };
  const seed = admitRunCompletionBatch({ ...input, members: [{ run: "seed", run_instance_id: "seed-generation",
    state_dir: join(agentDir, "seed", ownerId), status: "done", summary: "Controlled journal seed", terminal_at: "2026-09-01T12:00:00.000Z" }] });
  markRunCompletionBatchQueued({ ...input, batchId: seed.batch_id });
  markRunCompletionBatchPresented({ ...input, batchId: seed.batch_id });
  finalizeRunCompletionBatch({ ...input, batchId: seed.batch_id });
  return requestRunCompletionStream(input);
}

test("Internal stream session admission requires explicit fresh creation and never bootstraps or falls back", async () => {
  for (const reason of [undefined, "startup", "reload", "resume", "new", "fork"] as const) {
    const ownerId = "binding-reason-" + reason, active = staleContext(ownerId);
    active.context.isIdle = () => false;
    let admissions = 0;
    const harness = runtimeHarness({ completionStreamSessionAdmission: () => { admissions++; return true; } });
    harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId, reason ? { type: "session_start", reason } : undefined);
      const path = getRunDeliveryJournalPath(extensionTempDir, ownerId);
      await writeTerminalRun(ownerId, ownerId, "generation-" + ownerId);
      assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
      assert.equal(fs.existsSync(path), false);
      const target = seedStreamJournal(ownerId), before = fs.readFileSync(path);
      const result = harness.runtime.onTurnEnd(completedBoundary(), active.context);
      if (reason === "new" || reason === "fork") {
        assert.equal(admissions, 1);
        assert.ok(result?.entries?.length);
        const saved = readRunDeliveryJournal(extensionTempDir, ownerId);
        assert.equal(saved.completion_batch!.numbering!.stream_id, target.pending_stream_id);
        assert.equal(saved.completion_batch!.numbering!.kind === "stream" && saved.completion_batch!.numbering!.first_index, 0);
      } else {
        assert.equal(admissions, 0);
        assert.equal(result, undefined);
        assert.deepEqual(fs.readFileSync(path), before);
      }
      assert.equal(harness.sendAttempts(), 0);
    } finally { harness.runtime.close(); }
  }
  const ownerId = "binding-default-closed", active = staleContext(ownerId);
  active.context.isIdle = () => false;
  seedStreamJournal(ownerId);
  const path = getRunDeliveryJournalPath(extensionTempDir, ownerId), before = fs.readFileSync(path);
  const harness = runtimeHarness(); harness.setActiveContext(active.context);
  try {
    harness.runtime.start(active.context, ownerId, { type: "session_start", reason: "new" });
    await writeTerminalRun(ownerId, ownerId, "generation-default-closed");
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
    assert.deepEqual(fs.readFileSync(path), before);
  } finally { harness.runtime.close(); }
});

test("Internal stream binding accepts same-manager wrappers but rejects A B A contexts and old lifecycle callbacks", async () => {
  const ownerId = "binding-aba", alpha = staleContext(ownerId), beta = staleContext("binding-beta"), returned = staleContext(ownerId);
  for (const item of [alpha, beta, returned]) item.context.isIdle = () => false;
  const harness = runtimeHarness({ completionStreamSessionAdmission: () => true });
  const unstartedWatcher = harness.watcherOnChange()!, unstartedLoop = harness.reconciliationInput();
  harness.setActiveContext(alpha.context);
  try {
    harness.runtime.start(alpha.context, ownerId, { type: "session_start", reason: "new" });
    seedStreamJournal(ownerId);
    const dir = await writeTerminalRun(ownerId, ownerId, "generation-aba");
    const wrapper = { ...alpha.context };
    assert.equal(harness.runtime.isCurrentSessionContext(wrapper), true);
    const result = harness.runtime.onTurnEnd(completedBoundary(), wrapper)!;
    assert.ok(result.entries?.length);
    const entry = result.entries!.at(-1) as any;
    const path = getRunDeliveryJournalPath(extensionTempDir, ownerId), before = fs.readFileSync(path);
    const oldWatcher = harness.watcherOnChange()!, oldLoop = harness.reconciliationInput();
    harness.setActiveContext(beta.context);
    harness.runtime.start(beta.context, "binding-beta", { type: "session_start", reason: "new" });
    harness.setActiveContext(returned.context);
    harness.runtime.start(returned.context, ownerId, { type: "session_start", reason: "resume" });
    const statusCalls = returned.statusCalls();
    alpha.makeStale();
    assert.equal(harness.runtime.isCurrentSessionContext(alpha.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(wrapper), false);
    assert.equal(harness.runtime.isCurrentSessionContext({ ...returned.context }), true);
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), alpha.context), undefined);
    const messages = [entry];
    assert.equal(harness.runtime.projectContext(messages, alpha.context), messages);
    assert.deepEqual(harness.runtime.projectContext(messages, returned.context), messages);
    unstartedWatcher(); unstartedLoop.reconcile(); unstartedLoop.onError(new Error("Unstarted callback"));
    oldWatcher(); oldLoop.refreshWatcher(); oldLoop.reconcile(); oldLoop.onError(new Error("Revoked callback"));
    await delay(15);
    assert.equal(returned.statusCalls(), statusCalls);
    assert.equal(harness.callbackErrors(), 0);
    assert.equal(harness.runtime.isCurrentSessionContext(returned.context), true);
    assert.deepEqual(fs.readFileSync(path), before);
    assert.equal(fs.existsSync(join(dir, "terminal-handled.json")), false);
    assert.equal(harness.sendAttempts(), 0);
  } finally { harness.runtime.close(); }
});

test("Internal stream recovery holds unknown packets and activates pending targets only after exact acceptance", async () => {
  const ownerId = "binding-switch", active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness({ completionStreamSessionAdmission: () => true }); harness.setActiveContext(active.context);
  try {
    harness.runtime.start(active.context, ownerId, { type: "session_start", reason: "new" });
    seedStreamJournal(ownerId);
    const firstDir = await writeTerminalRun(ownerId, "binding-first", "generation-first");
    const result = harness.runtime.onTurnEnd(completedBoundary(), active.context)!;
    const entry = result.entries!.at(-1) as any;
    const original = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    const target = requestRunCompletionStream({ tempDir: extensionTempDir, ownerId });
    const path = getRunDeliveryJournalPath(extensionTempDir, ownerId), bytes = fs.readFileSync(path);
    active.setSessionBranch([{ type: "custom", id: "missing-parent", parentId: "unavailable" }]);
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
    assert.deepEqual(fs.readFileSync(path), bytes);
    assert.equal(fs.existsSync(join(firstDir, "terminal-handled.json")), false);
    active.setSessionBranch([{ ...entry, id: "accepted-stream-entry", parentId: null }]);
    await writeTerminalRun(ownerId, "binding-second", "generation-second");
    const next = harness.runtime.onTurnEnd(completedBoundary(), active.context)!;
    assert.ok(next.entries?.length);
    assert.equal(fs.existsSync(join(firstDir, "terminal-handled.json")), true);
    const saved = readRunDeliveryJournal(extensionTempDir, ownerId);
    assert.equal(saved.completion_batch!.numbering!.stream_id, target.pending_stream_id);
    assert.equal(saved.completion_batch!.numbering!.kind === "stream" && saved.completion_batch!.numbering!.first_index, 0);
    assert.equal(saved.completion_stream!.pending_stream_id, undefined);
    assert.equal(formatRunCompletionBatchMessage(original), entry.content);
    assert.equal(harness.sendAttempts(), 0);
  } finally { harness.runtime.close(); }
});

test("Internal stream admission refuses deferred and reused-manager grants and contains reentrant replacement", async () => {
  for (const decision of [false, Promise.resolve(true)] as const) {
    const ownerId = "binding-decision-" + typeof decision, active = staleContext(ownerId);
    active.context.isIdle = () => false;
    const harness = runtimeHarness({ completionStreamSessionAdmission: (() => decision) as any }); harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId, { type: "session_start", reason: "new" });
      seedStreamJournal(ownerId); await writeTerminalRun(ownerId, ownerId, "generation-" + ownerId);
      const path = getRunDeliveryJournalPath(extensionTempDir, ownerId), bytes = fs.readFileSync(path);
      assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
      assert.deepEqual(fs.readFileSync(path), bytes);
    } finally { harness.runtime.close(); }
  }
  const alpha = staleContext("binding-reentrant-a"), beta = staleContext("binding-reentrant-b");
  alpha.context.isIdle = beta.context.isIdle = () => false;
  let harness: ReturnType<typeof runtimeHarness>;
  harness = runtimeHarness({ completionStreamSessionAdmission: ctx => {
    if (ctx === alpha.context) {
      harness.setActiveContext(beta.context);
      harness.runtime.start(beta.context, "binding-reentrant-b", { type: "session_start", reason: "new" });
    }
    return true;
  } });
  harness.setActiveContext(alpha.context);
  try {
    harness.runtime.start(alpha.context, "binding-reentrant-a", { type: "session_start", reason: "new" });
    assert.equal(harness.runtime.isCurrentSessionContext(alpha.context), false);
    assert.equal(harness.runtime.isCurrentSessionContext(beta.context), true);
    seedStreamJournal("binding-reentrant-b"); await writeTerminalRun("binding-reentrant-b", "binding-reentrant-b", "generation-reentrant");
    assert.ok(harness.runtime.onTurnEnd(completedBoundary(), beta.context)?.entries?.length);
    const path = getRunDeliveryJournalPath(extensionTempDir, "binding-reentrant-b"), bytes = fs.readFileSync(path);
    const wrapper = { ...beta.context };
    harness.setActiveContext(wrapper);
    harness.runtime.start(wrapper, "binding-reentrant-b", { type: "session_start", reason: "new" });
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), wrapper), undefined);
    assert.deepEqual(fs.readFileSync(path), bytes);
  } finally { harness.runtime.close(); }
  const sender = staleContext("binding-send-a"), replacement = staleContext("binding-send-b");
  sender.context.isIdle = () => true; replacement.context.isIdle = () => false;
  const transport = runtimeHarness({ completionStreamSessionAdmission: () => true, onSend: () => {
    transport.setActiveContext(replacement.context);
    transport.runtime.start(replacement.context, "binding-send-b", { type: "session_start", reason: "new" });
  } });
  transport.setActiveContext(sender.context);
  try {
    transport.runtime.start(sender.context, "binding-send-a", { type: "session_start", reason: "new" });
    seedStreamJournal("binding-send-a");
    const dir = await writeTerminalRun("binding-send-a", "binding-send-a", "generation-send-a");
    assert.equal(transport.runtime.flushCompletionBatch(sender.context), true);
    assert.equal(transport.sendAttempts(), 1);
    assert.equal(readRunDeliveryJournal(extensionTempDir, "binding-send-a").completion_batch!.phase, "pending");
    assert.equal(fs.existsSync(join(dir, "terminal-handled.json")), false);
    assert.equal(sender.notifications().some(item => item.message.includes("- delivery: accepted")), false);
  } finally { transport.runtime.close(); }
});

test("Concurrent A B A startup admits only the last initialization even when the original context object is reused", async () => {
  const alpha = staleContext("binding-async-a"), beta = staleContext("binding-async-b");
  alpha.context.isIdle = beta.context.isIdle = () => false;
  let admissions = 0;
  const kernel = createActorExtensionRuntime({ getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
    registerTool: () => undefined, sendMessage: () => { throw new Error("No idle send expected"); },
    registerMessageRenderer: () => undefined, setActiveTools: () => undefined } as never,
    undefined, () => { admissions++; return true; });
  try {
    // Awaited preparation always yields; these controlled contexts test generation, not SDK DTO provenance.
    await Promise.all([
      kernel.onSessionStart(alpha.context, { type: "session_start", reason: "new" }),
      kernel.onSessionStart(beta.context, { type: "session_start", reason: "new" }),
      kernel.onSessionStart(alpha.context, { type: "session_start", reason: "new" }),
    ]);
    assert.equal(admissions, 1);
    beta.makeStale();
    assert.doesNotThrow(() => kernel.onAgentSettled(beta.context));
    seedStreamJournal("binding-async-a");
    await writeTerminalRun("binding-async-a", "binding-async-a", "generation-async-a");
    assert.ok(kernel.onTurnEnd(completedBoundary(), alpha.context)?.entries?.length);
  } finally {
    // Reused controlled managers are deliberately not shutdown authority; close via a fresh lifetime.
    const cleanup = staleContext("binding-async-cleanup");
    await kernel.onSessionStart(cleanup.context);
    kernel.onSessionShutdown("quit", cleanup.context);
  }
});

test("Actual SDK lifecycle keeps numbered history immutable across tree fork clone resume and ambiguous import without model calls", async () => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const scopes: any[] = [], errors: unknown[] = [];
  const factory = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
    const scope: any = { event: sessionStartEvent, admissions: 0 }; scopes.push(scope);
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => {
          scope.kernel = createActorExtensionRuntime({ ...pi,
            sendMessage: () => assert.fail("Controlled busy lifecycle must not dispatch idle completions"),
          }, undefined, () => { scope.admissions++; return true; });
          pi.on("session_start", async (event, ctx) => {
            // The whole controlled lifetime is busy, including watcher/settlement callbacks between manual boundaries.
            scope.ctx = { ...ctx, isIdle: () => false }; scope.event = event;
            await scope.kernel.onSessionStart(scope.ctx, event);
          });
          pi.on("session_shutdown", (event, ctx) => scope.kernel.onSessionShutdown(event.reason, ctx));
        }] } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" });
    created.session.prompt = async () => { throw new Error("This lifecycle fixture forbids model requests"); };
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sdk = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir, sessionManager: SessionManager.create(agentDir, join(agentDir, "binding-sessions")) });
  const bind = async (session: typeof sdk.session) => { await session.bindExtensions({ onError: error => errors.push(error.error) }); };
  sdk.setRebindSession(bind);
  try {
    await bind(sdk.session);
    assert.equal(scopes.at(-1).event.reason, "startup");
    assert.equal(scopes.at(-1).admissions, 0);
    assert.equal((await sdk.newSession()).cancelled, false);
    const alpha = scopes.at(-1), ownerId = sdk.session.sessionManager.getSessionId();
    assert.equal(alpha.event.reason, "new"); assert.equal(alpha.admissions, 1);
    seedStreamJournal(ownerId);
    await writeTerminalRun(ownerId, "sdk-binding-first", "generation-sdk-first");
    // Controlled busy-boundary probe uses a real SDK manager/lifecycle, not a generated model turn.
    const busy = alpha.ctx;
    const draft = alpha.kernel.onTurnEnd(completedBoundary(), busy).entries.at(-1);
    sdk.session.sessionManager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
    alpha.kernel.onContext([draft], alpha.ctx);
    const file = sdk.session.sessionManager.getSessionFile()!;
    await writeTerminalRun(ownerId, "sdk-binding-second", "generation-sdk-second");
    // Exercise background delivery before the manual boundary without depending on watcher timing.
    assert.doesNotThrow(() => alpha.kernel.onAgentSettled(alpha.ctx));
    const second = alpha.kernel.onTurnEnd(completedBoundary(), busy).entries.at(-1);
    assert.ok(second.content.startsWith("---\nindex: 1\n"));
    const path = getRunDeliveryJournalPath(extensionTempDir, ownerId), beforeTree = fs.readFileSync(path);
    const branchEntry = sdk.session.sessionManager.getLeafId()!;
    sdk.session.sessionManager.branch(branchEntry);
    assert.equal(alpha.kernel.onTurnEnd(completedBoundary(), busy).entries.at(-1).content, second.content);
    assert.deepEqual(fs.readFileSync(path), beforeTree);
    sdk.session.sessionManager.appendMessage({ role: "user", content: "Controlled fork point", timestamp: Date.now() });
    const forkPoint = sdk.session.sessionManager.getLeafId()!;
    const target = requestRunCompletionStream({ tempDir: extensionTempDir, ownerId });
    const retained = fs.readFileSync(path);
    assert.equal((await sdk.fork(forkPoint)).cancelled, false);
    const forked = scopes.at(-1), forkId = sdk.session.sessionManager.getSessionId();
    assert.notEqual(forkId, ownerId); assert.equal(forked.event.reason, "fork"); assert.equal(forked.admissions, 1);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(extensionTempDir, forkId)), false);
    assert.ok(sdk.session.sessionManager.getBranch().some((entry: any) => entry.type === "custom_message" && entry.content === draft.content));
    assert.equal(forked.kernel.onTurnEnd(completedBoundary(), { ...forked.ctx, isIdle: () => false }), undefined);
    assert.deepEqual(fs.readFileSync(path), retained);
    assert.equal((await sdk.switchSession(file)).cancelled, false);
    const resumed = scopes.at(-1);
    assert.equal(resumed.event.reason, "resume"); assert.equal(resumed.admissions, 0);
    assert.equal(resumed.kernel.onTurnEnd(completedBoundary(), { ...resumed.ctx, isIdle: () => false }), undefined);
    alpha.kernel.onContext([second], busy);
    assert.doesNotThrow(() => alpha.kernel.onAgentSettled(alpha.ctx));
    alpha.kernel.onSessionShutdown("quit", alpha.ctx);
    assert.deepEqual(fs.readFileSync(path), retained);
    assert.equal((await sdk.fork(forkPoint, { position: "at" })).cancelled, false);
    const cloneId = sdk.session.sessionManager.getSessionId();
    assert.notEqual(cloneId, ownerId); assert.notEqual(cloneId, forkId);
    assert.equal(fs.existsSync(getRunDeliveryJournalPath(extensionTempDir, cloneId)), false);
    const importedFile = join(agentDir, "controlled-binding-import.jsonl"); fs.copyFileSync(file, importedFile);
    assert.equal((await sdk.importFromJsonl(importedFile)).cancelled, false);
    const imported = scopes.at(-1);
    assert.equal(sdk.session.sessionManager.getSessionId(), ownerId);
    assert.equal(imported.event.reason, "resume"); assert.equal(imported.admissions, 0);
    assert.equal(imported.kernel.onTurnEnd(completedBoundary(), { ...imported.ctx, isIdle: () => false }), undefined);
    imported.kernel.onContext([second], imported.ctx);
    assert.deepEqual(fs.readFileSync(path), retained);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_stream!.pending_stream_id, target.pending_stream_id);
    assert.equal(sdk.session.isStreaming, false);
    assert.deepEqual(errors, []);
  } finally { await sdk.dispose(); }
});

test("Headless JSON/print/RPC running observations never require a terminal theme or disable mandatory completions", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const mode of ["json", "print", "rpc"]) {
    const ownerId = `headless-${mode}`; const run = `${ownerId}-work`;
    const active = staleContext(ownerId); active.context.mode = mode; active.context.hasUI = mode === "rpc";
    active.context.isIdle = () => false; active.context.hasPendingMessages = () => false;
    let themeReads = 0;
    Object.defineProperty(active.context.ui, "theme", { get() { themeReads++; throw Error("Theme not initialized"); } });
    const dir = await writeTerminalRun(ownerId, run, `generation-${mode}`);
    const meta = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...meta, pid: process.pid })); await rm(join(dir, "result.json"));
    const harness = runtimeHarness(); harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId);
      assert.equal(active.statusCalls(), 1); assert.equal(themeReads, 0); assert.equal(harness.callbackErrors(), 0);
      t.mock.timers.tick(30_000);
      assert.equal(active.statusCalls(), 1, `${mode} has no animation ticks`);
      harness.reconciliationInput().reconcile();
      assert.equal(active.statusCalls(), 2, `${mode} still reconciles`);
      harness.watcherOnChange()!();
      await delay(20);
      assert.equal(active.statusCalls(), 3, `${mode} still watches`);
      await writeTerminalRun(ownerId, run, `generation-${mode}`);
      const result = harness.runtime.onTurnEnd(completedBoundary(), active.context);
      assert.equal(result?.continue, true); assert.equal(harness.sendAttempts(), 0); assert.equal(harness.callbackErrors(), 0);
    } finally { harness.runtime.close(); }
  }
  t.mock.timers.reset();
});

test("stale animation ticks stop the Run UI runtime without escaping", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stale = staleContext();
  stale.context.mode = "tui";
  const harness = runtimeHarness({ animationIntervalMs: 5 });
  harness.setActiveContext(stale.context);
  harness.runtime.start(stale.context, "session-a");
  assert.equal(stale.statusCalls(), 1);

  const reads: string[] = [];
  const hooks = ["readFileSync", "readdirSync", "statSync", "lstatSync", "existsSync"].map(key => {
    const original = (fs as any)[key];
    return t.mock.method(fs as any, key, (...args: any[]) => { reads.push(key); return original(...args); });
  });
  const kill = process.kill;
  hooks.push(t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => { reads.push("kill"); return kill(...args); }));
  syncBuiltinESMExports();
  try {
    t.mock.timers.tick(15);
    assert.equal(stale.statusCalls(), 4);
    assert.deepEqual(reads, [], "animation must not observe discovery, status or native ports");
    stale.makeStale();
    t.mock.timers.tick(5);
    assert.equal(stale.statusCalls(), 4);
    assert.equal(harness.callbackErrors(), 1);
    t.mock.timers.tick(20);
    assert.equal(harness.callbackErrors(), 1);
    assert.equal(harness.watcherCloseCalls() >= 2, true);
    for (const hook of hooks) hook.mock.restore();
    syncBuiltinESMExports();
    const replacement = staleContext("replacement-animation");
    replacement.context.mode = "tui";
    harness.setActiveContext(replacement.context);
    harness.runtime.start(replacement.context, "replacement-animation");
    t.mock.timers.tick(5);
    assert.equal(replacement.statusCalls(), 2);
    const retiredWatcher = harness.watcherOnChange()!;
    harness.runtime.close();
    retiredWatcher();
    t.mock.timers.tick(20);
    assert.equal(replacement.statusCalls(), 2, "close revokes animation and stale watcher tickets");
    assert.equal(harness.callbackErrors(), 1);
    replacement.context.ui.setStatus = () => harness.runtime.close();
    harness.runtime.start(replacement.context, "replacement-animation");
    t.mock.timers.tick(20);
    assert.equal(harness.callbackErrors(), 1, "reentrant startup close creates no animation");
    const ui = replacement.context.ui;
    ui.setStatus = () => undefined;
    harness.runtime.start(replacement.context, "replacement-animation");
    ui.setStatus = () => {
      ui.setStatus = () => undefined;
      harness.runtime.start(replacement.context, "replacement-animation");
      throw new Error("Retired animation callback");
    };
    t.mock.timers.tick(5);
    assert.equal(harness.callbackErrors(), 1, "retired callback errors cannot close a same-context replacement");
    assert.equal(harness.runtime.isCurrentSessionContext(replacement.context), true);
  } finally {
    harness.runtime.close();
    for (const hook of hooks) hook.mock.restore();
    syncBuiltinESMExports();
    t.mock.timers.reset();
  }
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

test("AX runtime callback and teardown notices preserve original faults and report paths without closure claims", () => {
  const ownerId = "ax-runtime-notices", active = staleContext(ownerId);
  const report = "/reports/with```ticks\nsummary.json", cause = new Error("Original callback cause");
  const error = new Error("## Failure\r\n\r\n- next: authored · kept", { cause });
  const harness = runtimeHarness({ teardownFailed: true, summaryPath: report }); harness.setActiveContext(active.context);
  try {
    harness.runtime.start(active.context, ownerId); harness.reconciliationInput().onError(error);
    assert.equal(harness.callbackErrors(), 1); assert.equal(harness.callbackFailures()[0], error);
    assert.equal(error.cause, cause); assert.equal(error.message, "## Failure\r\n\r\n- next: authored · kept");
    assert.ok(harness.watcherCloseCalls() >= 2);
    const notice = active.notifications().find(item => item.message.startsWith("callback:")); assert.ok(notice);
    assert.equal(notice.level, "error");
    assert.equal(notice.message, noticeDocument({ callback: "terminal reconciliation callback", result: "failed",
      diagnostic: "## Failure\r\n\r\n- next: authored · kept" }));
    assert.doesNotMatch(notice.message, /^next:|rollback|no effects|handling: confirmed/mu);
    harness.runtime.shutdown("quit", ownerId, active.context);
    assert.deepEqual(harness.teardownInput(), { ownerId, trigger: "session_shutdown:quit" });
    const shutdown = active.notifications().find(item => item.message.startsWith("stage: \"shutdown teardown\"")); assert.ok(shutdown);
    assert.equal(shutdown.level, "warning");
    assert.equal(shutdown.message, noticeDocument({ stage: "shutdown teardown", killed: 0, failed: 1, skipped: 0,
      discovery_failed: 0, summary: "/reports/with```ticks\nsummary.json", basis: "teardown report; not scope closure" }));
  } finally { harness.runtime.close(); }
  // UI reports retain complete selected diagnostics beyond either model-emitter ceiling.
  for (const diagnostic of ["long · ".repeat(12000), "\ud800"]) {
    const context = staleContext(ownerId), runtime = runtimeHarness();
    const fault = new Error(diagnostic);
    runtime.setActiveContext(context.context);
    try {
      runtime.runtime.start(context.context, ownerId); runtime.reconciliationInput().onError(fault);
      assert.equal(runtime.callbackFailures()[0], fault);
      const notice = context.notifications().find(item => item.message.startsWith("callback:")); assert.ok(notice);
      const document = parseDocument(notice.message); assert.deepEqual(document.errors, []);
      const value = document.toJS();
      if (diagnostic.isWellFormed()) {
        assert.equal(value.diagnostic, diagnostic);
        assert.ok(Buffer.byteLength(notice.message) > 49152);
      } else {
        assert.equal(value.diagnostic, "[unavailable]");
        assert.equal(value.diagnostic_omission.reason, "malformed_selected_text");
      }
    } finally { runtime.runtime.close(); }
  }
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

test("Core YAML native renderer isolates bodies and literal service with bounded idempotent spacing", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { encodeCompletionYamlCarrier } = await import("../lib/run-delivery.ts");
  initTheme("dark", false);
  let renderer: any;
  registerRunCompletionRenderer({ registerMessageRenderer: (_type: string, value: unknown) => { renderer = value; } } as never);
  const first = '\uFEFF## Heading\r\n\r\n```text\nreferences: BODY_REF\nrun_files: BODY_PATH\n<!-- next: body -->\n{"index":99}\n---\nOPEN😀';
  const encoded = encodeCompletionYamlCarrier({ batchId: "TECHNICAL_BATCH", records: [
    { metadata: { index: "?", run: "first", state: "done", references: { nested: { child: "HIDE_REF" } }, run_files: { locations: { child: "HIDE_PATH" } } }, parts: [{ body: first }, { marker: "\n" }, { marker: "[2 characters omitted]" }] },
    { metadata: { index: 41, run: "peer", state: "failed", kind: "diagnostic" }, parts: [{ body: "## PEER_HEADING\n\n**PEER_BOLD**" }] }],
    service: { omitted_results: 2, omitted_states: { failed: 1 }, inventory_warning: "**LITERAL_WARNING**", numbering_unavailable: "counter_unavailable", result_inventory: { path: join(extensionTempDir, "inventory.json") }, other: { keep: true } } });
  assert.equal(encoded.state, "available"); if (encoded.state !== "available") return;
  const message = { content: encoded.text, details: { pi_actors_presentation: { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(encoded.text).digest("hex") } } };
  const original = JSON.stringify(message), theme = { fg: (_color: string, text: string) => text };
  const descriptors = Object.getOwnPropertyDescriptors(fs);
  try {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, { ...descriptors[key]!, value: () => assert.fail("Core native presentation must not read sources") });
    syncBuiltinESMExports();
    for (const width of [24, 52, 90, 140]) for (const outputPad of [0, 2]) {
      const component = renderer(message, { expanded: false, outputPad }, theme);
      const lines = component.render(width).map(stripTerminalSequences), text = lines.join("\n");
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      assert.ok(text.includes('index: "?"')); assert.ok(text.includes("index: 41"));
      assert.ok(text.includes("BODY_REF")); assert.ok(text.includes("BODY_PATH"));
      assert.ok(text.includes("PEER_HEADING")); assert.ok(text.includes("PEER_BOLD"));
      assert.doesNotMatch(text, /## PEER_HEADING|\*\*PEER_BOLD\*\*|HIDE_REF|HIDE_PATH|TECHNICAL_BATCH|_completion|Run Batch|Run result/u);
      assert.ok(text.includes("**LITERAL_WARNING**")); assert.ok(text.includes("omitted_results: 2"));
      assert.ok(text.includes("omitted_states:")); assert.ok(text.includes("result_inventory:")); assert.ok(text.includes("other:"));
      assert.equal((text.match(/Expand message/gu) ?? []).length, 1);
      assert.ok(!/\n(?: *\n){3}/u.test(text), "Compiler separators must not triple native gaps");
      component.invalidate(); assert.deepEqual(component.render(width).map(stripTerminalSequences), lines);
      for (const expanded of [true, false]) {
        const details = expanded ? message.details : {};
        const full = renderer({ ...message, details }, { expanded, outputPad }, theme).render(width).map(stripTerminalSequences);
        assert.ok(full.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
        const literal = full.join("\n");
        assert.ok(literal.includes("TECHNICAL_BATCH")); assert.ok(literal.includes("HIDE_REF"));
        assert.ok(literal.includes("**PEER_BOLD**"));
      }
    }
    assert.equal(JSON.stringify(message), original);
  } finally {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, descriptors[key]!);
    syncBuiltinESMExports();
  }
});

test("Core YAML native renderer keeps service-only and explicit body partitions without empty cards", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { encodeCompletionYamlCarrier } = await import("../lib/run-delivery.ts");
  initTheme("dark", false);
  let renderer: any;
  registerRunCompletionRenderer({ registerMessageRenderer: (_type: string, value: unknown) => { renderer = value; } } as never);
  const theme = { fg: (_color: string, text: string) => text };
  for (const parts of [undefined, [], [{ body: "" }], [{ body: " \n" }], [{ marker: "WARNING_ONLY" }]]) {
    const encoded = encodeCompletionYamlCarrier({ batchId: "HIDDEN_BATCH_ID", records: parts === undefined ? [] : [{ metadata: { index: 0, run: "r", state: "done" }, parts }], service: { omitted_results: 9, omitted_states: { killed: 2 }, inventory_warning: "NO_INVENTORY" } });
    assert.equal(encoded.state, "available"); if (encoded.state !== "available") continue;
    const message = { content: encoded.text, details: { pi_actors_presentation: { format: "completion_yaml_core_v1", content_sha256: createHash("sha256").update(encoded.text).digest("hex") } } };
    for (const width of [24, 52, 90, 140]) {
      const component = renderer(message, { expanded: false, outputPad: 2 }, theme);
      const lines = component.render(width).map(stripTerminalSequences), text = lines.join("\n");
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      assert.ok(text.includes("omitted_results: 9")); assert.ok(text.includes("NO_INVENTORY"));
      assert.equal(text.includes("index:"), parts !== undefined);
      assert.equal(text.includes("---"), !!parts?.length);
      assert.equal(text.includes("WARNING_ONLY"), !!parts?.some(part => "marker" in part));
      assert.doesNotMatch(text, /HIDDEN_BATCH_ID|_completion|Run Batch|Run result/u);
      component.invalidate(); assert.deepEqual(component.render(width).map(stripTerminalSequences), lines);
    }
  }
  assert.equal(renderer({ content: "---\nordinary prose", details: {} }, { expanded: false, outputPad: 0 }, theme), undefined);
});

function completedBoundary(entries: any[] = []): any {
  return { entries, outcome: "completed", context: { pendingMessages: [] }, turnIndex: 1 };
}

test("Fresh completion renderer separates metadata, Markdown and cut markers without source IO", async () => {
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  initTheme("dark", false);
  let renderer: any;
  registerRunCompletionRenderer({ registerMessageRenderer: (_type: string, value: unknown) => { renderer = value; } } as never);
  const body = "## Visible heading\n\n**FIRST_BOLD**\n\n```text\nreferences: KEEP_BODY_REFERENCE\nrun_files: KEEP_BODY_LOCATION\n---\nindex: 99\n[7 characters omitted]\n界😀\r\nOPEN_CODE";
  const make = (run: string, text: string, tail: string) => {
    const generation = `generation-${run}`, source = text + tail, shown = [...text].length;
    const stateDir = join(extensionTempDir, "runs", run), hash = createHash("sha256").update(source).digest("hex");
    return { run, run_instance_id: generation, state_dir: join(extensionTempDir, "runs", run), status: "done" as const,
      summary: "Run completed.", terminal_at: "2026-09-01T12:00:00.000Z",
      primary_text: { output: { text_basis: "actor_response" as const, upstream_truncated: false, redacted: false,
        preview: text, bytes_total: Buffer.byteLength(source), shown_bytes: { start: 0, end: Buffer.byteLength(text) },
        chars_shown: shown, chars_total: [...source].length, chars_omitted: [...tail].length, truncated: !!tail,
        source: { path: join(stateDir, "evidence", `primary-${hash}.txt`), run_instance_id: generation, sha256: hash } } } };
  };
  const batch = admitRunCompletionBatch({ members: [make("markdown", body, "TAIL"), make("peer", "**SECOND_BOLD**", "")],
    ownerId: "renderer-frontmatter", tempDir: extensionTempDir });
  const projected = projectRunCompletionBatchPresentation(batch), original = JSON.stringify(batch);
  assert.equal(projected.presentation!.format, "completion_yaml_core_v1");
  const message = { content: projected.content, details: { pi_actors_presentation: projected.presentation } };
  const theme = { fg: (_color: string, text: string) => text };
  const descriptors = Object.getOwnPropertyDescriptors(fs);
  try {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key,
      { ...descriptors[key]!, value: () => assert.fail("Rendering cannot read Run state or bodies") });
    syncBuiltinESMExports();
    for (const width of [24, 52, 90, 140]) {
      const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
      const lines = component.render(width).map(stripTerminalSequences), text = lines.join("\n");
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      assert.match(text, /^index: 0\s*$/mu); assert.match(text, /^index: 1\s*$/mu);
      assert.match(text, /^run: "markdown"\s*$/mu); assert.match(text, /^run: "peer"\s*$/mu);
      assert.ok(text.includes("Visible heading")); assert.doesNotMatch(text, /## Visible heading|\*\*FIRST_BOLD\*\*|\*\*SECOND_BOLD\*\*/u);
      assert.ok(text.includes("FIRST_BOLD")); assert.ok(text.includes("SECOND_BOLD"));
      assert.match(text, /^\[4 characters omitted\]\s*$/mu);
      assert.ok(text.includes("[7 characters omitted]")); assert.ok(text.includes("KEEP_BODY_REFERENCE"));
      assert.ok(text.includes("KEEP_BODY_LOCATION")); assert.ok(text.includes("index: 99"));
      assert.equal(text.includes("primary-"), false); assert.equal(text.includes(batch.batch_id), false);
      assert.doesNotMatch(text, /^#0:|^- (?:result|preview):|^Run Batch\s*$/mu);
      component.invalidate(); assert.deepEqual(component.render(width).map(stripTerminalSequences), lines);
    }
    for (const details of [{ pi_actors_presentation: { ...projected.presentation, content_sha256: "wrong" } }, {}]) {
      const fallback = renderer({ ...message, details }, { expanded: false, outputPad: 0 }, theme).render(140).map(stripTerminalSequences).join("\n");
      assert.ok(fallback.includes("## Visible heading")); assert.ok(fallback.includes(batch.batch_id));
    }
    const expanded = renderer(message, { expanded: true, outputPad: 0 }, theme).render(140).map(stripTerminalSequences).join("\n");
    assert.ok(expanded.includes("## Visible heading")); assert.ok(expanded.includes(batch.batch_id)); assert.ok(expanded.includes("primary-"));
    assert.equal(message.content, projected.content); assert.equal(JSON.stringify(batch), original);
  } finally {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, descriptors[key]!);
    syncBuiltinESMExports();
  }
});

test("Retained AX message renderer keeps two-column records and exact expansion/fallback without IO", async () => {
  let renderer: any, registrations = 0;
  registerRunCompletionRenderer({ registerMessageRenderer: (type: string, value: unknown) => { assert.equal(type, "pi-actors-run-batch"); registrations++; renderer = value; } } as never);
  assert.equal(registrations, 1);
  const ownerId = "renderer-v3", directory = join(extensionTempDir, "runs", "renderer");
  const opaque = "## Literal\r\n\r\n#1:\n- run: authored\n- technical: authored\n- batch: authored\n  - tool: not a call\n界😀 ````` retained\nEND";
  const batch = { batch_id: "saved-renderer", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
    presentation_format: "ax_records" as const, result_layout: "headings_shared_kinds" as const, text_budget: undefined,
    members: [{ run: "renderer", run_instance_id: "generation-renderer", state_dir: directory,
      status: "done" as const, summary: "Run completed.", output: opaque, terminal_at: "2026-08-31T12:00:00.000Z" }] };
  const projected = projectRunCompletionBatchPresentation(batch), original = JSON.stringify(batch);
  const message = { role: "custom", customType: "pi-actors-run-batch", content: projected.content, details: { pi_actors_presentation: projected.presentation } };
  const theme = { fg: (_color: string, text: string) => text };
  const descriptors = Object.getOwnPropertyDescriptors(fs), forbidden = () => assert.fail("Transcript rendering cannot read current Run sources");
  try {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, { ...descriptors[key]!, value: forbidden });
    syncBuiltinESMExports();
    for (const width of [24, 52, 90, 140]) {
      const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
      const lines = component.render(width).map(stripTerminalSequences);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      assert.ok(lines.some((line: string) => line.startsWith("- run: renderer")));
      assert.match(lines.join("\n"), /^#0:\s*$/mu);
      assert.doesNotMatch(lines.join("\n"), /Run Batch|^- members:|^\s*- #0:|^- completions:/mu);
      const text = lines.join("\n"); assert.equal(text.includes(batch.batch_id), false);
      assert.ok(text.includes("authored")); assert.ok(text.includes("`````")); assert.ok(text.includes("retained"));
      component.invalidate(); assert.deepEqual(component.render(width).map(stripTerminalSequences), lines);
      const expanded = renderer(message, { expanded: true, outputPad: 0 }, theme).render(140).map(stripTerminalSequences).join("\n");
      assert.ok(expanded.includes(batch.batch_id)); assert.match(expanded, /^<!-- pi-actors:completion /mu);
      assert.doesNotMatch(expanded, /^- (?:window_start|window_end|runtime_summaries|members|completions):/mu);
    }
    const fullText = "R".repeat(24 * 1024) + opaque, fullBytes = Buffer.byteLength(fullText), prefix = [...fullText].slice(0, 160).join("");
    const hash = createHash("sha256").update(fullText).digest("hex");
    const full = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, members: [{ ...batch.members[0]!, output: undefined,
      primary_text: { output: { text_basis: "actor_response", upstream_truncated: false, redacted: false,
        preview: prefix, bytes_total: fullBytes, shown_bytes: { start: 0, end: Buffer.byteLength(prefix) },
        chars_total: [...fullText].length, chars_shown: [...prefix].length, chars_omitted: [...fullText].length - [...prefix].length, truncated: true,
        source: { path: join(directory, "evidence", "primary-" + hash + ".txt"), run_instance_id: "generation-renderer", sha256: hash } } },
      completion_text: { text: fullText, shown_bytes: { start: 0, end: fullBytes } } }] });
    assert.ok(Buffer.byteLength(full.content) > 16 * 1024);
    for (const width of [24, 52, 90]) {
      const lines = renderer({ ...message, content: full.content, details: { pi_actors_presentation: full.presentation } },
        { expanded: false, outputPad: 0 }, theme).render(width).map(stripTerminalSequences);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
      assert.match(lines.join("\n"), /^- result:\s*$/mu); assert.equal(lines.join("\n").includes(batch.batch_id), false);
    }
    for (const hints of [undefined, {}, { ...projected.presentation, content_sha256: "wrong" }, { ...projected.presentation, compact_ranges: [[0, 2]] }]) {
      const fallback = renderer({ ...message, details: { pi_actors_presentation: hints } }, { expanded: false, outputPad: 0 }, theme).render(140).map(stripTerminalSequences).join("\n");
      assert.ok(fallback.includes(batch.batch_id)); assert.match(fallback, /^<!-- pi-actors:completion /mu);
    }
    const old = formatRunCompletionBatchMessage({ ...batch, text_budget: undefined, result_layout: undefined, single_result: undefined, presentation_format: "ax_records_v2" });
    assert.equal(renderer({ ...message, content: old, details: {} }, { expanded: false, outputPad: 0 }, theme), undefined);
    const retained = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, result_layout: undefined, single_result: undefined, presentation_format: "ax_records_v3" });
    const retainedMessage = { ...message, content: retained.content, details: { pi_actors_presentation: retained.presentation } };
    assert.equal(retained.presentation!.format, "ax_records_v3");
    const indexed = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, result_layout: undefined, single_result: undefined });
    assert.deepEqual(renderer(retainedMessage, { expanded: false, outputPad: 0 }, theme).render(90),
      renderer({ ...message, content: indexed.content, details: { pi_actors_presentation: indexed.presentation } }, { expanded: false, outputPad: 0 }, theme).render(90),
      "Both older indexed spellings keep their original compact view without rewriting content");
    const mismatch = { ...retainedMessage, details: { pi_actors_presentation: { ...retained.presentation, format: "ax_records" } } };
    assert.ok(renderer(mismatch, { expanded: false, outputPad: 0 }, theme).render(140).join("\n").includes(batch.batch_id));
    const multiple = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, single_result: undefined, members: [batch.members[0]!,
      { ...batch.members[0]!, run: "peer", run_instance_id: "generation-peer", state_dir: join(directory, "peer") }] });
    for (const width of [24, 52, 90, 140]) {
      const text = renderer({ ...message, content: multiple.content, details: { pi_actors_presentation: multiple.presentation } },
        { expanded: false, outputPad: 0 }, theme).render(width).map(stripTerminalSequences).join("\n");
      assert.doesNotMatch(text, /^Run Batch\s*$|^- (?:completions|members|window_start|window_end):/mu);
      assert.match(text, /^#0:\s*$/mu); assert.match(text, /^#1:\s*$/mu);
      assert.match(text, /^- run: peer\s*$/mu);
    }
    for (const members of [batch.members, [...batch.members, { ...batch.members[0]!, run: "peer", run_instance_id: "generation-peer", state_dir: join(directory, "peer") }]]) {
      const prior = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, result_layout: "records", members });
      const priorText = renderer({ ...message, content: prior.content, details: { pi_actors_presentation: prior.presentation } },
        { expanded: false, outputPad: 0 }, theme).render(140).map(stripTerminalSequences).join("\n");
      if (members.length === 1) assert.match(priorText, /^Run result\s*$/mu);
      else { assert.match(priorText, /^- #0:\s*$/mu); assert.match(priorText, /^  - run: peer\s*$/mu); }
    }
    const common = { session_id: ownerId, stream_id: "01234567-89ab-4cde-8fab-0123456789ab", member_order: [0] };
    for (const numbering of [{ ...common, kind: "stream" as const, first_index: 0 }, { ...common, kind: "stream" as const, first_index: 41 },
      { ...common, kind: "stream" as const, first_index: Number.MAX_SAFE_INTEGER - 1 }, { ...common, kind: "unavailable" as const, reason: "counter_unavailable" as const }]) {
      const numbered = projectRunCompletionBatchPresentation({ ...batch, text_budget: undefined, numbering });
      const numberedMessage = { ...message, content: numbered.content, details: { pi_actors_presentation: numbered.presentation } };
      for (const width of [24, 52, 90, 140]) {
        const component = renderer(numberedMessage, { expanded: false, outputPad: 0 }, theme);
        const lines = component.render(width).map(stripTerminalSequences);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= width && !/[\r\n]/u.test(line)));
        const text = lines.join("\n");
        assert.doesNotMatch(text, /Run Batch|Run result|completion_numbering/u);
        if (numbering.kind === "stream") assert.match(text, new RegExp("^#" + numbering.first_index + ":\\s*$", "mu"));
        else assert.match(text, /^#\?:\s*$/mu);
        assert.ok(renderer(numberedMessage, { expanded: true, outputPad: 0 }, theme).render(140).join("\n").includes("completion_numbering"));
      }
    }
    assert.equal(message.content, projected.content); assert.equal(JSON.stringify(batch), original);
  } finally {
    for (const key of ["readFileSync", "readdirSync", "statSync", "lstatSync"]) Object.defineProperty(fs, key, descriptors[key]!);
    syncBuiltinESMExports();
  }
});

test("Fresh UI completion admissions select AX while all historical formats recover without retrofit or resend", async () => {
  for (const format of ["absent", "bracketed_omissions_v1", "ax_records_v1", "ax_records_v2", "ax_records_v3", "ax_records", "flat_single"] as const) {
    const excerpt_format = format === "bracketed_omissions_v1" ? format : undefined;
    const presentation_format = format === "flat_single" ? "ax_records" : format === "ax_records_v1" || format === "ax_records_v2" || format === "ax_records_v3" || format === "ax_records" ? format : undefined;
    for (const navigation_handoff of [undefined, "current_session_request", "captured_file_locations"] as const) {
      for (const phase of ["pending", "queued", "presented"] as const) {
        const suffix = `${format}-${navigation_handoff ?? "absent"}-${phase}`;
        const ownerId = `ax-compat-${suffix}`, run = `old-${suffix}`, generation = `generation-${suffix}`;
        const stateDir = await writeTerminalRun(ownerId, run, generation);
        const members = [{ run, run_instance_id: generation, state_dir: stateDir, status: "done" as const,
          summary: "Saved legacy value `exact`", terminal_at: "2026-09-01T12:01:00.000Z" }];
        const legacyFacts = { batch_id: `saved-${suffix}`, created_at: "2026-09-01T12:01:00.000Z", members };
        // Initialize only the journal shell; historical packet facts never inherit fresh core capture fields.
        admitRunCompletionBatch({ members, ownerId, tempDir: extensionTempDir });
        const timestamp = "2026-09-01T12:02:00.000Z";
        const legacy = { ...legacyFacts, text_budget: undefined, result_layout: undefined, single_result: format === "flat_single" ? true as const : undefined, excerpt_format, presentation_format, navigation_handoff, file_navigation: navigation_handoff === "captured_file_locations" ? [] : undefined,
          phase, ...(phase !== "pending" ? { queued_at: timestamp } : {}), ...(phase === "presented" ? { presented_at: timestamp } : {}) };
        const prior = readRunDeliveryJournal(extensionTempDir, ownerId), content = formatRunCompletionBatchMessage(legacy);
        assert.match(content, format === "flat_single" ? /^- completion:/ : presentation_format ? /^- completions:/ : /^Actor completions:/);
        await writeFile(getRunDeliveryJournalPath(extensionTempDir, ownerId), JSON.stringify({ ...prior, completion_batch: legacy }));
        const active = staleContext(ownerId); active.context.isIdle = () => false;
        const harness = runtimeHarness(); harness.setActiveContext(active.context);
        try {
          harness.runtime.start(active.context, ownerId);
          if (phase === "pending") {
            const first = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
            assert.equal(first.content, content); assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!.presentation_format, presentation_format);
            assert.equal((harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any).content, content);
            harness.runtime.projectContext([first], active.context);
          } else {
            assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
          }
          assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
          assert.equal(JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8")).run_instance_id, generation);
          assert.equal(harness.sendAttempts(), 0, "Accepted historical packets finalize without resend; pending drafts use the unchanged boundary");
          const freshRun = `fresh-${suffix}`, freshGeneration = `fresh-generation-${suffix}`;
          await writeTerminalRun(ownerId, freshRun, freshGeneration);
          const fresh = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
          const admitted = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
          assert.equal(admitted.presentation_format, "ax_records"); assert.equal(admitted.excerpt_format, undefined);
          assert.equal(admitted.members.length, 1); assert.equal(admitted.members[0].run, freshRun); assert.equal(admitted.members[0].run_instance_id, freshGeneration);
          assert.equal(admitted.result_layout, "completion_yaml_core_v1"); assert.equal(admitted.single_result, undefined);
          const header = freshCoreHeaders(fresh.content)[0];
          assert.deepEqual([header.index, header.run, header.state], [0, freshRun, "done"]);
          assert.equal(header._completion.codec, "completion_yaml_core_v1"); assert.equal(header._completion.batch_id, admitted.batch_id);
          assert.doesNotMatch(fresh.content, /^- completions:|^- members:|^\s*- #0:/mu);
          assert.equal((harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any).content, fresh.content);
          assert.equal(harness.sendAttempts(), 0);
          const { details: _details, ...stripped } = fresh;
          harness.runtime.projectContext([stripped], active.context);
          assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).receipts.length, 2);
        } finally { harness.runtime.close(); }
      }
    }
  }
});

test("New terminal admissions capture current-session file locations once and preserve them after source loss", async () => {
  const ownerId = "session-terminal-locations", active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness(); harness.setActiveContext(active.context); harness.runtime.start(active.context, ownerId);
  try {
    const run = "terminal-locations", generation = "generation-terminal-locations";
    claimRunStateDirectory(join(extensionTempDir, "runs", run), run);
    const directory = await writeTerminalRun(ownerId, run, generation);
    const entry = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
    const pending = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
    assert.equal(pending.navigation_handoff, "captured_file_locations");
    assert.equal(pending.file_navigation!.length, 1); const locations = pending.file_navigation![0].locations;
    assert.equal(locations.state, "available");
    if (locations.state !== "available") return;
    assert.equal(locations.directory, directory); assert.equal(locations.run_instance_id, generation);
    assert.equal(locations.files.find(file => file.role === "result")!.path, join(directory, "result.json"));
    assert.deepEqual(freshCoreHeaders(entry.content)[0].run_files, { run, run_instance_id: generation, locations });
    await rm(join(directory, "result.json"));
    const retry = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0] as any;
    assert.equal(retry.content, entry.content, "An admitted/proposed packet is never refreshed from current sources");
    const foreign = staleContext("foreign-terminal-locations");
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), foreign.context), undefined);
    assert.deepEqual(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!.file_navigation, pending.file_navigation);
  } finally { harness.runtime.close(); }
});

test("Root completion delivery never promotes a foreign-session child into file navigation or probes its slots", async () => {
  const ownerId = "session-terminal-root", active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness(); harness.setActiveContext(active.context); harness.runtime.start(active.context, ownerId);
  const parent = "terminal-own-parent", child = "terminal-foreign-child";
  claimRunStateDirectory(join(extensionTempDir, "runs", parent), parent);
  claimRunStateDirectory(join(extensionTempDir, "runs", child), child);
  const parentDir = await writeTerminalRun(ownerId, parent, "generation-own-parent");
  const childDir = await writeTerminalRun("child-session-not-root", child, "generation-foreign-child", {
    deliveryOwnerId: ownerId, parent: { run: parent, runInstanceId: "generation-own-parent", stateDir: parentDir } });
  const lstat = fs.lstatSync; let childIdentityProbes = 0;
  fs.lstatSync = ((path, ...args) => {
    if (String(path) === childDir && (args[0] as { bigint?: boolean } | undefined)?.bigint === true) childIdentityProbes++;
    return Reflect.apply(lstat, fs, [path, ...args]);
  }) as typeof fs.lstatSync; syncBuiltinESMExports();
  let entry: any, batch: ReturnType<typeof readRunDeliveryJournal>["completion_batch"];
  try {
    entry = harness.runtime.onTurnEnd(completedBoundary(), active.context)!.entries![0];
    batch = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch;
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); harness.runtime.close(); }
  assert.ok(batch); assert.equal(batch.members.length, 2); assert.ok(entry.content.includes(child));
  const index = batch.members.findIndex(member => member.run === child);
  assert.deepEqual(batch.file_navigation!.find(row => row.member_index === index)!.locations, { state: "unavailable", reason: "session_mismatch" });
  assert.equal(childIdentityProbes, 0, "Known foreign observations must be filtered before navigation identity filesystem probes");
  assert.ok(!entry.content.includes(childDir));
});

test("Recipient replacement during terminal location observation cannot admit or expose a new packet", async () => {
  const ownerId = "session-terminal-replaced", active = staleContext(ownerId);
  let current = ownerId; active.context.sessionManager.getSessionId = () => current; active.context.isIdle = () => false;
  const harness = runtimeHarness(); harness.setActiveContext(active.context); harness.runtime.start(active.context, ownerId);
  const run = "terminal-replaced"; claimRunStateDirectory(join(extensionTempDir, "runs", run), run);
  const directory = await writeTerminalRun(ownerId, run, "generation-terminal-replaced");
  const lstat = fs.lstatSync; let replaced = false;
  fs.lstatSync = ((path, ...args) => {
    if (String(path) === join(directory, "stdout.log")) { replaced = true; current = "foreign-terminal-replaced"; }
    return Reflect.apply(lstat, fs, [path, ...args]);
  }) as typeof fs.lstatSync; syncBuiltinESMExports();
  try { assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined); }
  finally { fs.lstatSync = lstat; syncBuiltinESMExports(); harness.runtime.close(); }
  assert.equal(replaced, true); assert.equal(harness.sentMessages().length, 0);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
  assert.equal(readRunDeliveryJournal(extensionTempDir, "foreign-terminal-replaced").completion_batch, undefined);
});

test("active boundaries batch fresh completions without native steering or early acknowledgment", async () => {
  const ownerId = "session-active-boundary";
  const active = staleContext(ownerId);
  let idle = false;
  active.context.isIdle = () => idle;
  const harness = runtimeHarness();
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  const firstDir = await writeTerminalRun(ownerId, "boundary-first", "boundary-generation-first");
  const secondDir = await writeTerminalRun(ownerId, "boundary-second", "boundary-generation-second");
  const priorEntry = { type: "custom", customType: "another-extension", data: { keep: true } };
  // No watcher event: the boundary itself must discover the latest durable results.
  const freshContext = { ...active.context };
  const result = harness.runtime.onTurnEnd(completedBoundary([priorEntry]), freshContext)!;
  assert.equal(result.continue, true);
  assert.equal(result.entries!.length, 2);
  assert.equal(result.entries![0], priorEntry);
  const entry = result.entries![1] as any;
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.customType, "pi-actors-run-batch");
  assert.equal(entry.display, true);
  assert.equal(freshCoreHeaders(entry.content).filter(row => Number.isSafeInteger(row.index)).length, 2);
  assert.equal(harness.sendAttempts(), 0);
  const pending = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!;
  assert.equal(pending.phase, "pending");
  await assert.rejects(readFile(join(firstDir, "terminal-handled.json")), /ENOENT/);
  await assert.rejects(readFile(join(secondDir, "terminal-handled.json")), /ENOENT/);

  const thirdDir = await writeTerminalRun(ownerId, "boundary-third", "boundary-generation-third");
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!.members.length, 2);
  const { details: _details, ...modelEntry } = entry;
  harness.runtime.projectContext([modelEntry], freshContext);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
  assert.equal(JSON.parse(await readFile(join(firstDir, "terminal-handled.json"), "utf8")).run_instance_id,
    "boundary-generation-first");
  const next = harness.runtime.onTurnEnd(completedBoundary(), freshContext)!;
  assert.equal(freshCoreHeaders((next.entries![0] as any).content)[0].run, "boundary-third");
  assert.match((next.entries![0] as any).content, /boundary-third/);
  harness.runtime.projectContext(next.entries!, freshContext);
  assert.equal(JSON.parse(await readFile(join(thirdDir, "terminal-handled.json"), "utf8")).run_instance_id,
    "boundary-generation-third");
  idle = true;
  assert.equal(harness.runtime.flushCompletionBatch(freshContext), false);
  assert.equal(harness.sendAttempts(), 0);
  harness.runtime.close();
});

test("active completion boundaries refuse unsafe outcomes, native pending input and foreign owners", async () => {
  const ownerId = "session-boundary-guards";
  const active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness();
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  await writeTerminalRun(ownerId, "boundary-guarded", "boundary-generation-guarded");
  const event = completedBoundary();
  for (const outcome of ["aborted", "error"]) {
    assert.equal(harness.runtime.onTurnEnd({ ...event, outcome }, active.context), undefined);
  }
  const aborted = new AbortController();
  aborted.abort();
  for (const override of [
    { signal: aborted.signal },
    { hasPendingMessages: () => true },
    { isIdle: () => true },
    { sessionManager: { getSessionId: () => "foreign-owner" } },
  ]) {
    assert.equal(harness.runtime.onTurnEnd(event, { ...active.context, ...override }), undefined);
  }
  assert.equal(harness.runtime.onTurnEnd({
    ...event, context: { pendingMessages: [{ role: "user", content: "native input" }] },
  }, active.context), undefined);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
  assert.equal(harness.sendAttempts(), 0);
  assert.ok(harness.runtime.onTurnEnd(event, active.context));
  harness.runtime.close();
  assert.equal(harness.runtime.onTurnEnd(event, active.context), undefined);
});

test("a dropped boundary proposal retries the same immutable batch without acknowledging it", async () => {
  const ownerId = "session-boundary-dropped";
  const active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness();
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  const stateDir = await writeTerminalRun(ownerId, "boundary-dropped", "boundary-generation-dropped");
  const first = harness.runtime.onTurnEnd(completedBoundary(), active.context)!;
  // A later extension can replace the draft chain before Pi commits it.
  const retry = harness.runtime.onTurnEnd(completedBoundary(), active.context)!;
  assert.deepEqual(retry, first);
  await assert.rejects(readFile(join(stateDir, "terminal-handled.json")), /ENOENT/);
  harness.runtime.projectContext(retry.entries!, active.context);
  assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
  assert.equal(harness.sendAttempts(), 0);
  harness.runtime.close();
});

test("restart acknowledges a committed boundary entry even when its context callback was missed", async () => {
  for (const strip of [false, true]) {
    const suffix = strip ? "stripped" : "detailed", ownerId = "session-boundary-restart-" + suffix;
    const run = "boundary-restart-" + suffix, generation = "boundary-generation-restart-" + suffix;
    const active = staleContext(ownerId); active.context.isIdle = () => false;
    const first = runtimeHarness(); first.setActiveContext(active.context); first.runtime.start(active.context, ownerId);
    const stateDir = await writeTerminalRun(ownerId, run, generation);
    const proposed = first.runtime.onTurnEnd(completedBoundary(), active.context)!, entry = proposed.entries![0] as any;
    const { details: _details, ...stripped } = entry;
    active.setSessionBranch([{ ...(strip ? stripped : entry), id: "committed-boundary", parentId: null }]);
    first.runtime.close();
    await assert.rejects(readFile(join(stateDir, "terminal-handled.json")), /ENOENT/);
    const recovered = runtimeHarness(); recovered.setActiveContext(active.context); recovered.runtime.start(active.context, ownerId);
    assert.equal(recovered.runtime.onTurnEnd(completedBoundary(), active.context), undefined); assert.equal(recovered.sendAttempts(), 0);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
    assert.equal(JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8")).run_instance_id, generation);
    active.context.isIdle = () => true; assert.equal(recovered.runtime.flushCompletionBatch(active.context), false);
    recovered.runtime.close();
  }
});

test("uncertain boundary acceptance fails closed instead of resending or marking terminals handled", async () => {
  const ownerId = "session-boundary-uncertain";
  const active = staleContext(ownerId);
  active.context.isIdle = () => false;
  const harness = runtimeHarness();
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  const stateDir = await writeTerminalRun(ownerId, "boundary-uncertain", "boundary-generation-uncertain");
  const result = harness.runtime.onTurnEnd(completedBoundary(), active.context)!;
  const entry = result.entries![0] as any;
  for (const sessionEntry of [
    { ...entry, content: `${entry.content}\nconflicting output`, id: "conflict", parentId: null },
    { type: "custom", id: "missing-parent", parentId: "unavailable" },
    { ...entry, details: undefined, content: entry.content + "\ntrailing data", id: "broken-record-marker", parentId: null },
    { ...entry, details: undefined, content: entry.content.replace(/^index: 0$/mu, "index: 1"), id: "broken-record-heading", parentId: null },
    { ...entry, details: undefined, content: entry.content.replace(`  batch_id: ${JSON.stringify(freshCoreHeaders(entry.content)[0]._completion.batch_id)}`, ""), id: "missing-record-marker", parentId: null },
  ]) {
    active.setSessionBranch([sessionEntry]);
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
    assert.equal(harness.runtime.onTurnEnd(completedBoundary(), active.context), undefined);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch!.phase, "pending");
  }
  const notices = active.notifications().filter(item => item.message.startsWith("\n" + 'batch: '));
  assert.equal(notices.length, 3);
  for (const notice of notices) {
    assert.equal(notice.level, "warning");
    assert.match(notice.message, /^\nbatch: "[^"]+"\nstage: "completion recovery"\nevidence: "(?:conflict|unknown)"\nphase: "pending"\nreason: /u);
    assert.equal(notice.message.startsWith("\n\n"), false);
    // The SDK prepends this literal heading; exercise its native Text layout without patching the host.
    for (const width of [24, 52, 90, 140]) {
      const lines = new Text("Warning: " + notice.message, 1, 0).render(width).map(stripTerminalSequences);
      assert.equal(lines[0]!.trim(), "Warning:");
      // Narrow widths may wrap the hop between the field name and its quoted value.
      assert.ok(lines.join(" ").replaceAll(/\s+/gu, " ").includes('batch: "'));
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  }
  await assert.rejects(readFile(join(stateDir, "terminal-handled.json")), /ENOENT/);
  assert.equal(harness.sendAttempts(), 0);
  harness.runtime.close();
});

test("completion batches wait for idle and acknowledge exact accepted generations", async () => {
  const ownerId = "session-batch";
  const firstDir = await writeTerminalRun(ownerId, "batch-first", "generation-first");
  const secondDir = await writeTerminalRun(ownerId, "batch-second", "generation-second");
  await writeFile(
    join(firstDir, "terminal-delivery-failure.json"),
    JSON.stringify({ attempts: 1, error: "legacy transport failure" }),
  );
  const active = staleContext(ownerId);
  let idle = false;
  (active.context as any).isIdle = () => idle;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  harness.watcherOnChange()!();
  await delay(20);

  assert.equal(harness.sentMessages().length, 0);
  assert.equal(
    readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch,
    undefined,
  );

  idle = true;
  assert.equal(harness.runtime.flushCompletionBatch(active.context), true);
  assert.equal(harness.sentMessages().length, 1);
  const firstMessage = harness.sentMessages()[0]!.message;
  assert.equal(firstMessage.customType, "pi-actors-run-batch");
  assert.equal(freshCoreHeaders(firstMessage.content).filter(row => Number.isSafeInteger(row.index)).length, 2);
  assert.deepEqual(harness.sentMessages()[0]!.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  const firstHandled = JSON.parse(
    await readFile(join(firstDir, "terminal-handled.json"), "utf8"),
  );
  assert.equal(firstHandled.run_instance_id, "generation-first");
  await assert.rejects(
    readFile(join(firstDir, "terminal-delivery-failure.json")),
    /ENOENT/,
  );

  await writeTerminalRun(ownerId, "batch-second", "generation-second-replacement");
  const modelMessage = { ...firstMessage };
  delete modelMessage.details;
  assert.equal(
    harness.runtime.projectContext([modelMessage, modelMessage], active.context).length,
    1,
  );
  await assert.rejects(readFile(join(secondDir, "terminal-handled.json")), /ENOENT/);

  assert.equal(harness.runtime.flushCompletionBatch(active.context), true);
  assert.equal(harness.sentMessages().length, 2);
  const replacementMessage = harness.sentMessages()[1]!.message;
  assert.equal(freshCoreHeaders(replacementMessage.content)[0].run, "batch-second");
  assert.match(replacementMessage.content, /batch-second/);
  harness.runtime.projectContext([replacementMessage], active.context);
  const replacementHandled = JSON.parse(
    await readFile(join(secondDir, "terminal-handled.json"), "utf8"),
  );
  assert.equal(
    replacementHandled.run_instance_id,
    "generation-second-replacement",
  );
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).receipts.length, 2);
  harness.runtime.close();
});

test("hot completion acceptance finalizes without context replay", async () => {
  const ownerId = "session-hot-settle";
  const stateDir = await writeTerminalRun(
    ownerId,
    "hot-settle",
    "generation-hot-settle",
  );
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  await delay(20);
  assert.equal(harness.sentMessages().length, 1);

  assert.equal(
    JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"))
      .run_instance_id,
    "generation-hot-settle",
  );
  assert.equal(
    readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch,
    undefined,
  );
  assert.deepEqual(active.notifications(), [], "Successful delivery adds no separate acceptance toast");
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).receipts.length, 1);
  assert.equal(harness.runtime.flushCompletionBatch(active.context), false);
  assert.equal(harness.sentMessages().length, 1, "Quiet success still durably accepts without resend");
  harness.runtime.close();
});

test("root completion batches compress foreign-owner descendants into one tree", async () => {
  const ownerId = "session-tree-root";
  const rootDir = await writeTerminalRun(
    ownerId,
    "tree-root",
    "generation-tree-root",
    { deliveryOwnerId: ownerId },
  );
  await writeTerminalRun(
    "session-tree-child",
    "tree-child",
    "generation-tree-child",
    {
      deliveryOwnerId: ownerId,
      parent: {
        run: "tree-root",
        runInstanceId: "generation-tree-root",
        stateDir: rootDir,
      },
    },
  );
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  await delay(20);

  assert.equal(harness.sentMessages().length, 1);
  const message = harness.sentMessages()[0]!.message;
  assert.equal(freshCoreHeaders(message.content).filter(row => Number.isSafeInteger(row.index)).length, 2);
  const headers = freshCoreHeaders(message.content);
  assert.deepEqual(headers.map(row => row.run), ["tree-root", "tree-child"]);
  assert.equal(headers[1].parent_run, "tree-root");
  assert.deepEqual(active.notifications(), [], "A multi-result tree has no outer count or delivery toast");
  harness.runtime.projectContext([message], active.context);
  harness.runtime.close();
});

test("idle completion debounce snapshots one immutable completion epoch", async (t) => {
  const ownerId = "session-idle-epoch";
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 500, notificationDelayMs: 1 });
  harness.setActiveContext(active.context);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    harness.runtime.start(active.context, ownerId);
    await writeTerminalRun(ownerId, "idle-first", "generation-idle-first");
    harness.watcherOnChange()!(); t.mock.timers.tick(1);
    assert.equal(harness.sentMessages().length, 0);
    t.mock.timers.tick(100);
    await writeTerminalRun(ownerId, "idle-second", "generation-idle-second");
    harness.watcherOnChange()!(); t.mock.timers.tick(1);
    t.mock.timers.tick(499); assert.equal(harness.sentMessages().length, 0);
    t.mock.timers.tick(1); assert.equal(harness.sentMessages().length, 1);
    assert.equal(freshCoreHeaders(harness.sentMessages()[0]!.message.content).filter(row => Number.isSafeInteger(row.index)).length, 2);
    harness.runtime.projectContext([harness.sentMessages()[0]!.message], active.context);
  } finally { harness.runtime.close(); t.mock.timers.reset(); }
});

test("restart finalizes an accepted queued batch without reformatting or resend", async () => {
  const ownerId = "session-accepted-recovery";
  const stateDir = await writeTerminalRun(
    ownerId,
    "accepted-recovery",
    "generation-accepted-recovery",
  );
  admitRunCompletionBatch({
    batchId: "accepted-before-restart",
    members: [{
      run: "accepted-recovery",
      run_instance_id: "generation-accepted-recovery",
      state_dir: stateDir,
      status: "done",
      summary: "Old formatter content is irrelevant after acceptance.",
      terminal_at: "2026-09-01T12:01:00.000Z",
    }],
    ownerId,
    tempDir: extensionTempDir,
  });
  markRunCompletionBatchQueued({
    batchId: "accepted-before-restart",
    ownerId,
    tempDir: extensionTempDir,
  });
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  await delay(20);

  assert.equal(harness.sentMessages().length, 0);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch, undefined);
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"))
      .run_instance_id,
    "generation-accepted-recovery",
  );
  harness.runtime.close();
});

test("pending completion send failures remain durable and retryable", async () => {
  const ownerId = "session-send-failure";
  const stateDir = await writeTerminalRun(
    ownerId,
    "batch-send-failure",
    "generation-send-failure",
  );
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const failing = runtimeHarness({ deliveryDebounceMs: 5, sendFailures: 1 });
  failing.setActiveContext(active.context);
  failing.runtime.start(active.context, ownerId);
  await delay(20);
  assert.equal(failing.sendAttempts(), 1);
  assert.equal(failing.callbackErrors(), 1);
  const pending = readRunDeliveryJournal(extensionTempDir, ownerId).completion_batch;
  assert.equal(pending?.phase, "pending");
  assert.equal(pending?.attempts, 1);
  assert.match(pending?.last_error ?? "", /simulated completion send failure/);
  await assert.rejects(readFile(join(stateDir, "terminal-handled.json")), /ENOENT/);

  const retry = runtimeHarness({ deliveryDebounceMs: 5 });
  retry.setActiveContext(active.context);
  retry.runtime.start(active.context, ownerId);
  await delay(20);
  assert.equal(retry.sentMessages().length, 1);
  retry.runtime.projectContext([retry.sentMessages()[0]!.message], active.context);
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"))
      .run_instance_id,
    "generation-send-failure",
  );
  retry.runtime.close();
});

test("explicit urgent steer reaches Pi before the eventual terminal batch", async () => {
  const ownerId = "session-urgent-steer";
  const stateDir = await writeTerminalRun(
    ownerId,
    "urgent-steer",
    "generation-urgent-steer",
  );
  const event = appendRunTraceEvent(stateDir, {
    attention: "steer",
    kind: "checkpoint.blocked",
    level: "warning",
    summary: "Approval required before migration",
  });
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);

  assert.equal(harness.sentMessages().length, 1);
  const steerMessage = harness.sentMessages()[0]!.message;
  assert.equal(steerMessage.customType, "pi-actors-run-steer");
  assert.equal(steerMessage.details.pi_actors_delivery.event_id, event.id);
  assert.deepEqual(harness.sentMessages()[0]!.options, {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.equal(
    readRunDeliveryJournal(extensionTempDir, ownerId).steers[0]?.phase,
    "queued",
  );
  harness.runtime.projectContext([steerMessage, steerMessage], active.context);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers.length, 0);
  assert.equal(
    readRunTraceEvents(stateDir).some((item: any) =>
      item.kind === "delivery.steer_presented" && item.data?.event_id === event.id),
    true,
  );
  await assert.rejects(readFile(join(stateDir, "terminal-handled.json")), /ENOENT/);

  harness.runtime.flushCompletionBatch(active.context);
  assert.equal(harness.sentMessages().length, 2);
  const completionMessage = harness.sentMessages()[1]!.message;
  assert.equal(completionMessage.customType, "pi-actors-run-batch");
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"))
      .run_instance_id,
    "generation-urgent-steer",
  );
  assert.deepEqual(
    readRunDeliveryJournal(extensionTempDir, ownerId).receipts.map((item: any) =>
      item.kind),
    ["urgent_steer", "completion_batch"],
  );
  harness.runtime.close();
});

test("canonical urgent steer preserves checkpoint and whole references inside its byte cap", async () => {
  const ownerId = "session-steer-whole-references";
  const stateDir = await writeTerminalRun(ownerId, "steer-whole-references", "generation-whole-references");
  const paths = (prefix: string) => Array.from({ length: 8 }, (_, index) =>
    "/tmp/steer-refs/" + prefix + index + "/" + Array(35).fill("β".repeat(30)).join("/") + "/result-" + index + ".log");
  const artifacts = paths("artifact-"); const files = paths("file-");
  const event = appendRunTraceEvent(stateDir, { attention: "steer", kind: "checkpoint.blocked",
    summary: "Approval required before migration", data: {
      artifacts: Object.fromEntries(artifacts.map((path, index) => [String(index), path])), run_files: files,
    } });
  const active = staleContext(ownerId); active.context.isIdle = () => true;
  const harness = runtimeHarness(); harness.setActiveContext(active.context);
  try {
    harness.runtime.start(active.context, ownerId);
    assert.equal(harness.sentMessages().length, 1);
    const message = harness.sentMessages()[0]!.message;
    const text = message.content as string;
    assert.ok(Buffer.byteLength(text) <= 16 * 1024);
    assert.equal(Buffer.from(text).toString("utf8"), text);
    const doc = parseDocument(text, { uniqueKeys: true }); assert.deepEqual(doc.errors, []);
    const metadata = doc.toJS();
    assert.equal(metadata.run, "steer-whole-references"); assert.equal(metadata.checkpoint, "Approval required before migration");
    assert.equal(message.details.pi_actors_delivery.event_id, event.id);
    let totalShown = 0; let totalOmitted = 0;
    for (const [label, originals] of [["artifacts", artifacts], ["run_files", files]] as const) {
      const section = metadata[label];
      assert.ok(section !== undefined, "Every optional reference group has explicit coverage");
      const paths = section.paths ?? [];
      assert.deepEqual(paths, originals.slice(0, paths.length));
      const omitted = originals.length - paths.length;
      assert.deepEqual(section, { shown: paths.length, omitted, total: 8, ...(paths.length ? { paths } : {}) });
      totalShown += paths.length; totalOmitted += omitted;
    }
    assert.ok(totalShown > 0 && totalOmitted > 0);
    assert.equal(totalShown + totalOmitted, 16);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers[0]?.content, text);
    harness.runtime.projectContext([message], active.context);
    assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers.length, 0);
  } finally { harness.runtime.close(); }
});

test("urgent steer send failure remains durable without stopping observation", async () => {
  const ownerId = "session-steer-failure";
  const stateDir = await writeTerminalRun(
    ownerId,
    "steer-failure",
    "generation-steer-failure",
  );
  appendRunTraceEvent(stateDir, {
    attention: "steer",
    kind: "checkpoint.blocked",
    summary: "Retry this steer",
  });
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5, sendFailures: 1 });
  harness.setActiveContext(active.context);
  harness.runtime.start(active.context, ownerId);
  await delay(20);

  assert.equal(harness.callbackErrors(), 0);
  assert.equal(harness.sendAttempts(), 2);
  assert.equal(harness.sentMessages().length, 1);
  const steer = readRunDeliveryJournal(extensionTempDir, ownerId).steers[0];
  assert.equal(steer?.phase, "queued");
  assert.equal(steer?.attempts, 1);
  assert.match(steer?.last_error ?? "", /simulated completion send failure/);
  harness.runtime.projectContext([harness.sentMessages()[0]!.message], active.context);
  harness.runtime.close();
});

test("Steer diagnostic clipping hides raw tail counts and preserves existing failure evidence", async () => {
  const diagnostics: string[] = [];
  for (const length of [4, 4000, -1, 0, 240, 241]) {
    const ownerId = "session-steer-diagnostic-" + length;
    const stateDir = await writeTerminalRun(ownerId, "steer-diagnostic-" + length, "generation-diagnostic-" + length);
    appendRunTraceEvent(stateDir, { attention: "steer", kind: "checkpoint.blocked", summary: "Checkpoint" });
    const cause = new Error("Original transport cause");
    const message = length < 0 ? "d".repeat(239) + "\ud800tail" : length === 0 ? "## Failure\r\n\r\n- next: authored · keep"
      : length === 240 || length === 241 ? "d".repeat(length) : "d".repeat(239) + "🌍" + "H".repeat(length);
    const error = new Error(message, { cause });
    const active = staleContext(ownerId); active.context.isIdle = () => true;
    const harness = runtimeHarness({ sendFailures: 1, sendError: error });
    harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId);
      const notice = active.notifications().find(item => item.message.includes('stage: "delivery"'));
      assert.ok(notice);
      assert.equal(notice.level, "error");
      assert.match(notice.message, /\nattention: "steer"\nstage: "delivery"\nresult: "request failed"\ndelivery: "unconfirmed"\npresentation: "unconfirmed"/u);
      if (length < 0) {
        assert.ok(notice.message.endsWith('diagnostic: "unavailable"\ndiagnostic_reason: "malformed legacy preview"\ndiagnostic_omission: "[omitted: unknown]"'));
        assert.doesNotMatch(notice.message, /\ud800|\ufffd|…/u);
      } else if (length === 0) {
        assert.ok(notice.message.endsWith("diagnostic: " + JSON.stringify(message)));
        assert.doesNotMatch(notice.message, /diagnostic_omission|^next:/mu);
      } else if (length === 240) {
        assert.ok(notice.message.endsWith("diagnostic: " + JSON.stringify(message))); assert.doesNotMatch(notice.message, /diagnostic_omission|…/u);
      } else {
        const prefix = "d".repeat(length === 241 ? 240 : 239);
        assert.ok(notice.message.endsWith("diagnostic: " + JSON.stringify(prefix + "…") + '\ndiagnostic_omission: "[omitted: unknown]"'));
        assert.doesNotMatch(notice.message, /\[omitted: \d+ chars\]/u);
      }
      assert.equal(Buffer.from(notice.message).toString("utf8"), notice.message);
      const retained = readRunDeliveryJournal(extensionTempDir, ownerId).steers[0];
      assert.equal(retained?.phase, "pending");
      assert.equal(retained?.attempts, 1);
      assert.equal(retained?.last_error, error.message.replaceAll(/\s+/gu, " ").trim().slice(0, 4096));
      assert.equal(error.message, message); assert.equal(error.cause, cause);
      assert.equal(harness.sendAttempts(), 1);
      if (length === 4 || length === 4000) diagnostics.push(notice.message.slice(notice.message.indexOf("diagnostic:")));
    } finally { harness.runtime.close(); }
  }
  assert.equal(diagnostics[0], diagnostics[1]);
});

test("AX steer diagnostics retain retryable admission and queued recovery without inventing effects or rewriting content", async () => {
  for (const mode of ["missing_generation", "malformed_checkpoint"] as const) {
    const ownerId = "ax-diagnostic-" + mode, run = "diagnostic-" + mode;
    const stateDir = await writeTerminalRun(ownerId, run, "generation-" + mode);
    if (mode === "missing_generation") {
      const path = join(stateDir, "run.json"), metadata = JSON.parse(await readFile(path, "utf8")); delete metadata.run_instance_id;
      await writeFile(path, JSON.stringify(metadata));
    }
    const event = appendRunTraceEvent(stateDir, { attention: "steer", kind: "checkpoint.blocked", summary: mode === "malformed_checkpoint" ? "invalid\ud800checkpoint" : "Checkpoint" });
    const active = staleContext(ownerId); active.context.isIdle = () => true;
    const harness = runtimeHarness(); harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId);
      const notices = active.notifications().filter(item => item.message.includes('stage: "admission"'));
      assert.equal(notices.length, 1); assert.equal(notices[0].level, "warning");
      assert.ok(notices[0].message.startsWith('event: ' + JSON.stringify(event.id) + '\nattention: "steer"\nstage: "admission"\nresult: "remains retryable"\ndiagnostic: "'));
      assert.ok(notices[0].message.includes(mode === "missing_generation" ? "Run generation unavailable." : "Unicode/byte delivery limits"));
      assert.doesNotMatch(notices[0].message, /admission: (?:not applied|refused)|delivery: (?:confirmed|not sent)|handling: confirmed/);
      assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers.length, 0); assert.equal(harness.callbackErrors(), 0);
    } finally { harness.runtime.close(); }
  }
  for (const evidence of ["unknown", "conflict"] as const) {
    const ownerId = "ax-diagnostic-recovery-" + evidence, run = "diagnostic-recovery-" + evidence;
    const stateDir = await writeTerminalRun(ownerId, run, "generation-" + evidence);
    const event = appendRunTraceEvent(stateDir, { attention: "steer", kind: "checkpoint.blocked", summary: "Checkpoint" });
    const active = staleContext(ownerId); active.context.isIdle = () => true;
    const first = runtimeHarness(); first.setActiveContext(active.context);
    let exact: any;
    try { first.runtime.start(active.context, ownerId); exact = first.sentMessages()[0]!.message; } finally { first.runtime.close(); }
    const before = readRunDeliveryJournal(extensionTempDir, ownerId).steers[0]; assert.ok(before);
    active.setSessionBranch(evidence === "unknown" ? [{ id: "gap", parentId: "missing", type: "message" }]
      : [{ ...exact, content: exact.content + " conflict", id: "conflict", parentId: null, type: "custom_message" }]);
    const recovered = runtimeHarness(); recovered.setActiveContext(active.context);
    try {
      recovered.runtime.start(active.context, ownerId);
      const notice = active.notifications().find(item => item.message.includes('stage: "recovery"')); assert.ok(notice);
      assert.equal(notice.level, "warning"); assert.ok(notice.message.startsWith('event: ' + JSON.stringify(event.id) + '\nattention: "steer"\nstage: "recovery"\nevidence: "' + evidence + '"'));
      assert.ok(notice.message.includes('\nphase: "queued"\nreason: '));
      assert.equal(recovered.sendAttempts(), 0); assert.equal(recovered.callbackErrors(), 0);
      assert.deepEqual(readRunDeliveryJournal(extensionTempDir, ownerId).steers[0], before);
      assert.equal(exact.content, before.content);
    } finally { recovered.runtime.close(); }
  }
});

test("AX steer rollout reuses saved text before new formatting across pending queued and presented recovery", async () => {
  for (const phase of ["pending", "queued", "presented"] as const) {
    const ownerId = "ax-steer-replay-" + phase, run = "ax-steer-" + phase, generation = "generation-ax-steer-" + phase;
    const stateDir = await writeTerminalRun(ownerId, run, generation);
    const event = appendRunTraceEvent(stateDir, { attention: "steer", kind: "checkpoint.blocked", summary: "invalid\ud800checkpoint" });
    const content = "Run " + run + ": retained older checkpoint\nRun files:\n- Files: `old-partial…";
    const saved = admitRunSteerEnvelope({ content, eventId: event.id, kind: event.kind, level: "warning", occurredAt: event.ts,
      ownerId, run, runInstanceId: generation, stateDir, tempDir: extensionTempDir });
    assert.ok(saved);
    const input = { ownerId, steerId: saved.steer_id, tempDir: extensionTempDir };
    if (phase !== "pending") markRunSteerQueued(input);
    if (phase === "presented") markRunSteerPresented(input);
    const exact = { type: "custom_message", customType: "pi-actors-run-steer", content, display: false,
      details: { pi_actors_delivery: { kind: "urgent_steer", event_id: event.id, steer_id: saved.steer_id } } };
    const active = staleContext(ownerId); active.context.isIdle = () => false;
    if (phase === "queued") active.setSessionBranch([{ ...exact, id: "saved-" + phase, parentId: null }]);
    const harness = runtimeHarness(); harness.setActiveContext(active.context);
    try {
      harness.runtime.start(active.context, ownerId);
      assert.equal(harness.callbackErrors(), 0); assert.equal(active.notifications().some(item => /remains retryable|conflicts with a different envelope/.test(item.message)), false);
      if (phase === "pending") {
        assert.equal(harness.sentMessages().length, 1); assert.equal(harness.sentMessages()[0].message.content, content);
        assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers[0].content, content);
        harness.runtime.projectContext([harness.sentMessages()[0].message], active.context);
      } else if (phase === "queued") {
        assert.equal(harness.sentMessages().length, 0); assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers[0].content, content);
        harness.runtime.projectContext([exact], active.context);
      } else assert.equal(harness.sentMessages().length, 0);
      assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers.length, 0);
      assert.ok(readRunTraceEvents(stateDir).some(item => item.kind === "delivery.steer_presented" && item.data &&
        typeof item.data === "object" && "event_id" in item.data && item.data.event_id === event.id));
    } finally { harness.runtime.close(); }
  }
});

test("queued urgent steer waits on exact owned session evidence", async () => {
  const ownerId = "session-steer-recovery";
  const stateDir = await writeTerminalRun(
    ownerId,
    "steer-recovery",
    "generation-steer-recovery",
  );
  const event = appendRunTraceEvent(stateDir, {
    attention: "steer",
    kind: "checkpoint.blocked",
    summary: "Recover this steer",
  });
  const legacyContent = "Run steer-recovery: retained legacy text\nRun files:\n- Files: `old-partial…";
  admitRunSteerEnvelope({ content: legacyContent, eventId: event.id, kind: event.kind, level: "info",
    occurredAt: event.ts, ownerId, run: "steer-recovery", runInstanceId: "generation-steer-recovery",
    stateDir, tempDir: extensionTempDir });
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  const first = runtimeHarness({ deliveryDebounceMs: 5 });
  first.setActiveContext(active.context);
  first.runtime.start(active.context, ownerId);
  const exact = first.sentMessages()[0]!.message;
  assert.equal(exact.content, legacyContent);
  assert.equal(active.notifications().some(item => /conflicts with a different envelope/.test(item.message)), false);
  first.runtime.close();

  active.setSessionBranch([{
    ...exact,
    id: "session-steer-entry",
    parentId: null,
    type: "custom_message",
  }]);
  const recovered = runtimeHarness({ deliveryDebounceMs: 5 });
  recovered.setActiveContext(active.context);
  recovered.runtime.start(active.context, ownerId);
  await delay(20);
  assert.equal(recovered.sentMessages().length, 0);
  assert.equal(
    readRunDeliveryJournal(extensionTempDir, ownerId).steers[0]?.phase,
    "queued",
  );
  recovered.runtime.projectContext([exact], active.context);
  assert.equal(readRunDeliveryJournal(extensionTempDir, ownerId).steers.length, 0);
  recovered.runtime.close();
});

test("settled delivery accepts a fresh context wrapper for the same session owner", async () => {
  const ownerId = "session-context-wrapper";
  await writeTerminalRun(
    ownerId,
    "context-wrapper",
    "generation-context-wrapper",
  );
  const started = staleContext(ownerId);
  const settled = staleContext(ownerId);
  (settled.context as any).isIdle = () => true;
  const harness = runtimeHarness({ deliveryDebounceMs: 5 });
  harness.setActiveContext(started.context);
  harness.runtime.start(started.context, ownerId);

  assert.equal(harness.runtime.flushCompletionBatch(settled.context), true);
  assert.equal(harness.sentMessages().length, 1);
  assert.match(harness.sentMessages()[0]!.message.content, /context-wrapper/);
  harness.runtime.close();
});

test("agent settled flush closes a missed-watcher completion race", {
  skip: process.platform === "win32"
    ? "Node's Windows fs watcher asserts when its watched directory is removed"
    : false,
}, async () => {
  const ownerId = "session-settled-race";
  const definitions = new Map<string, any>();
  const sent: any[] = [];
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [...definitions.keys()],
    getAllTools: () => [...definitions.values()],
    getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    registerMessageRenderer: () => undefined,
    setActiveTools: () => undefined,
  } as never);
  const active = staleContext(ownerId);
  (active.context as any).isIdle = () => true;
  await extension.onSessionStart(active.context);
  const stateDir = await writeTerminalRun(
    ownerId,
    "settled-race",
    "generation-settled-race",
  );

  extension.onAgentSettled(active.context);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /settled-race/);
  extension.onContext([sent[0].message], active.context);
  assert.equal(
    JSON.parse(await readFile(join(stateDir, "terminal-handled.json"), "utf8"))
      .run_instance_id,
    "generation-settled-race",
  );
  extension.onAgentSettled(active.context);
  assert.equal(sent.length, 1);
  extension.onSessionShutdown("quit", active.context);
});

function teardownReports() {
  const path = join(extensionTempDir, "runs", "teardown");
  return fs.existsSync(path) ? fs.readdirSync(path).map(name => ({ file: name, ...JSON.parse(fs.readFileSync(join(path, name), "utf8")) })) : [];
}

test("Parent shutdown binds fresh wrappers once and refuses retired same-owner lifetimes without native actuation", {
  skip: process.platform === "win32" ? "Node's Windows fs watcher asserts when its watched directory is removed" : false,
}, async () => {
  for (const stream of [false, true]) {
    const ownerId = "shutdown-binding-" + stream;
    const extension = createActorExtensionRuntime({
      getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off",
      registerTool: () => undefined, sendMessage: () => undefined,
      registerMessageRenderer: () => undefined, setActiveTools: () => undefined,
    } as never, undefined, stream ? () => true : undefined);
    const start = (ctx: any) => extension.onSessionStart(ctx, { type: "session_start", reason: "new" });
    try {
      const alpha = staleContext(ownerId);
      await start(alpha.context);
      const beforeReports = teardownReports(), before = beforeReports.length;
      const foreign = staleContext(ownerId);
      extension.onSessionShutdown("quit", foreign.context);
      extension.onSessionShutdown("quit", { get sessionManager() { throw new Error("Unknown stale wrapper"); } } as never);
      assert.equal(teardownReports().length, before, "Equal logical ids and unknown invalidated wrappers cannot identify the current lifetime");
      const fresh = { ...alpha.context };
      extension.onSessionShutdown("quit", fresh);
      const report = teardownReports().find(item => !beforeReports.some(old => old.file === item.file));
      assert.equal(teardownReports().length, before + 1);
      assert.equal(report.ownerId, ownerId);
      assert.equal(report.trigger, "session_shutdown:quit");
      assert.equal(report.attempted, 0, "Controlled sessions have no live workload or native actuation");
      alpha.makeStale();
      assert.doesNotThrow(() => extension.onSessionShutdown("quit", alpha.context));
      extension.onSessionShutdown("quit", fresh);
      assert.equal(teardownReports().length, before + 1, "The lifetime is consumed once");

      const old = staleContext(ownerId), returned = staleContext(ownerId);
      await start(old.context);
      const oldWrapper = { ...old.context };
      await start(staleContext(ownerId + "-b").context);
      await start(returned.context);
      old.makeStale();
      const retiredCount = teardownReports().length;
      assert.doesNotThrow(() => extension.onSessionShutdown("quit", old.context));
      extension.onSessionShutdown("quit", oldWrapper);
      assert.equal(teardownReports().length, retiredCount, "A B A cannot revive an old original context or manager");
      returned.makeStale();
      assert.doesNotThrow(() => extension.onSessionShutdown("quit", returned.context));
      assert.equal(teardownReports().length, retiredCount + 1, "The current captured context needs no stale getter read");

      await start(oldWrapper);
      extension.onSessionShutdown("quit", oldWrapper);
      assert.equal(teardownReports().length, retiredCount + 1, "A reused retired manager cannot mint new shutdown authority");

      const reentrant = staleContext(ownerId + "-reentrant"), replacement = staleContext(ownerId + "-replacement");
      await start(reentrant.context);
      let nextStart: Promise<void> | undefined;
      extension.onSessionShutdown("quit", { get sessionManager() {
        nextStart = start(replacement.context);
        return reentrant.context.sessionManager;
      } } as never);
      await nextStart;
      assert.equal(teardownReports().length, retiredCount + 1, "A replacement during wrapper validation withholds the old teardown");
      extension.onSessionShutdown("quit", { ...replacement.context });
      assert.equal(teardownReports().length, retiredCount + 2);

      const failedUi = staleContext(ownerId + "-ui-failure");
      failedUi.context.mode = "tui";
      await start(failedUi.context);
      failedUi.context.ui.setStatus = () => { throw new Error("Controlled shutdown UI failure"); };
      await delay(1_050);
      assert.ok(failedUi.notifications().some(item => item.message.includes("Controlled shutdown UI failure")));
      const failedUiCount = teardownReports().length;
      extension.onSessionShutdown("reload", { ...failedUi.context });
      assert.equal(teardownReports().length, failedUiCount + 1, "UI callback failure does not erase the parent shutdown binding");
    } finally {
      const cleanup = staleContext(ownerId + "-cleanup");
      await start(cleanup.context);
      extension.onSessionShutdown("quit", cleanup.context);
    }
  }
});

test("Actual default SDK shutdown routes each outgoing session through captured-owner teardown without model calls", async () => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const scopes: any[] = [], errors: unknown[] = [];
  const factory = async ({ cwd, sessionManager, sessionStartEvent }: any) => {
    const scope: any = {}; scopes.push(scope);
    const services = await createAgentSessionServices({ cwd, agentDir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => {
          scope.kernel = createActorExtensionRuntime(pi);
          pi.on("session_start", async (event, ctx) => { scope.ctx = ctx; scope.ownerId = ctx.sessionManager.getSessionId(); await scope.kernel.onSessionStart(ctx, event); });
          pi.on("session_shutdown", (event, ctx) => {
            assert.notEqual(ctx, scope.ctx, "Actual SDK supplies a fresh shutdown context");
            assert.equal(ctx.sessionManager, scope.ctx.sessionManager);
            const before = teardownReports();
            scope.kernel.onSessionShutdown(event.reason, ctx);
            const after = teardownReports();
            assert.equal(after.length, before.length + 1);
            const report = after.find(item => !before.some(old => old.file === item.file));
            assert.equal(report?.ownerId, scope.ownerId);
            assert.equal(report?.trigger, "session_shutdown:" + event.reason);
            assert.ok(report);
            assert.equal(report.attempted, 0, "This real lifecycle fixture starts no Actor or native workload");
            scope.shutdown = event.reason;
          });
        }] } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" });
    created.session.prompt = async () => { throw new Error("This shutdown fixture forbids model requests"); };
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const sdk = await createAgentSessionRuntime(factory, { cwd: agentDir, agentDir,
    sessionManager: SessionManager.create(agentDir, join(agentDir, "shutdown-sessions")) });
  const bind = async (session: typeof sdk.session) => { await session.bindExtensions({ onError: error => errors.push(error.error) }); };
  sdk.setRebindSession(bind);
  try {
    await bind(sdk.session);
    const first = scopes.at(-1), file = sdk.session.sessionManager.getSessionFile()!;
    sdk.session.sessionManager.appendMessage({ role: "user", content: "Controlled shutdown fork point", timestamp: Date.now() });
    const forkPoint = sdk.session.sessionManager.getLeafId()!;
    assert.equal((await sdk.newSession()).cancelled, false);
    assert.equal(first.shutdown, "new");
    const second = scopes.at(-1);
    assert.equal((await sdk.switchSession(file)).cancelled, false);
    assert.equal(second.shutdown, "resume");
    const resumed = scopes.at(-1);
    assert.equal((await sdk.fork(forkPoint)).cancelled, false);
    assert.equal(resumed.shutdown, "fork");
  } finally { await sdk.dispose(); }
  assert.equal(scopes.at(-1).shutdown, "quit");
  assert.deepEqual(errors, [], "SDK-normalized shutdown failures must not disappear behind successful disposal");
});

test("a delayed old-session shutdown cannot close the replacement runtime", {
  skip: process.platform === "win32"
    ? "Node's Windows fs watcher asserts when its watched directory is removed"
    : false,
}, async () => {
  const definitions = new Map<string, any>();
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [...definitions.keys()],
    getAllTools: () => [...definitions.values()],
    getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition),
    sendMessage: () => undefined,
    registerMessageRenderer: () => undefined,
    setActiveTools: () => undefined,
  } as never);
  const alpha = staleContext("session-alpha");
  const beta = staleContext("session-beta");
  beta.context.mode = "tui";
  await extension.onSessionStart(alpha.context);
  await extension.onSessionStart(beta.context);
  const betaStatusCalls = beta.statusCalls();
  alpha.makeStale();

  assert.doesNotThrow(() => extension.onSessionShutdown("quit", alpha.context));
  await delay(1_050);
  assert.equal(beta.statusCalls() > betaStatusCalls, true);
  extension.onSessionShutdown("quit", beta.context);
});

test("extension shutdown never re-reads an invalidated context", {
  skip: process.platform === "win32"
    ? "Node's Windows fs watcher asserts when its watched directory is removed"
    : false,
}, async () => {
  const definitions = new Map<string, any>();
  const extension = createActorExtensionRuntime({
    getActiveTools: () => [...definitions.keys()],
    getAllTools: () => [...definitions.values()],
    getThinkingLevel: () => "off",
    registerTool: (definition: any) => definitions.set(definition.name, definition),
    sendMessage: () => undefined,
    registerMessageRenderer: () => undefined,
    setActiveTools: () => undefined,
  } as never);
  const stale = staleContext();
  await extension.onSessionStart(stale.context);
  stale.makeStale();

  assert.doesNotThrow(() => extension.onSessionShutdown("quit", stale.context));
});
