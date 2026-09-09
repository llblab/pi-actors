import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotificationSink,
  dedupeRunCompletionBatchContext,
  sendRunCompletionBatch,
} from "../lib/pi.ts";

test("Model context recognizes completion identity when Pi strips private details", () => {
  const content = [
    "Actor completions: 1",
    "Batch: `batch-without-details`",
    "- `worker` — `done`: Run completed.",
  ].join("\n");
  const message = {
    role: "custom",
    customType: "pi-actors-run-batch",
    content,
    display: false,
  };
  const projected = dedupeRunCompletionBatchContext([message]);
  assert.equal(projected.batches.get("batch-without-details"), content);
  assert.deepEqual(projected.messages, [message]);
});

test("Completion delivery restores one visible operator card", () => {
  const sent: any[] = [];
  sendRunCompletionBatch({
    sendMessage: (message: unknown, options: unknown) =>
      sent.push({ message, options }),
  } as never, "batch-visible", "Actor completions: 1\nBatch: `batch-visible`");
  assert.equal(sent[0].message.display, true);
  assert.deepEqual(sent[0].options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});

test("Actor notifications queue follow-ups for busy agents and trigger an idle turn", () => {
  const sent: unknown[] = [];
  const sink = createNotificationSink(
    {
      sendMessage: (message: unknown, options: unknown) => {
        sent.push({ message, options });
      },
    } as never,
    {
      ui: { notify: () => {} },
    } as never,
  );
  const message = {
    customType: "pi-actors-run",
    content: "Run review completed.",
    display: false as const,
    details: { run: "review" },
  };
  sink.sendFollowUp(message);
  assert.deepEqual(sent, [
    {
      message,
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
});
