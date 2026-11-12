import "./test-environment.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotificationSink,
  inspectRunCompletionBatchSessionEvidence,
  dedupeRunCompletionBatchContext,
  removeRunCompletionBatchFromContext,
  sendRunCompletionBatch,
} from "../lib/pi.ts";
import { projectRunCompletionBatchPresentation, readRunCompletionRecordMarker } from "../lib/run-delivery.ts";

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
  // Direct accessor/coercion conservation probe, not an SDK-cloneable DTO.
  let reads = 0; const events: string[] = [];
  const opaque = { toString() { events.push("coerce"); return content; } };
  const changing = Object.defineProperty({ ...message }, "content", { get() { reads++; events.push("read" + reads); return reads % 5 === 4 ? opaque : content; } });
  assert.equal(dedupeRunCompletionBatchContext([changing]).batches.get("batch-without-details"), content);
  assert.deepEqual(events, ["read1", "read2", "read3", "read4", "coerce", "read5", "read6", "read7", "read8", "read9", "coerce", "read10"]);
});

test("AX retained headers and record footers preserve exact identity without private details or authored-label authority", () => {
  const body = "- run: worker\n- state: done\n- output:\n  - completion: authored\n  - batch: authored\n  Batch: `body-id`\u2028Batch: `unicode-body-id`";
  const footer = '\n<!-- pi-actors:completion "ax-header" -->';
  for (const content of ["- completions: 1\n- batch: ax-header\n" + body,
    "- completion: ax-header\n- presentation: ax_records\n" + body,
    body + footer, "- #0:\n  " + body.replaceAll("\n", "\n  ") + footer]) {
    const message = { role: "custom", customType: "pi-actors-run-batch", content, display: true };
    const projected = dedupeRunCompletionBatchContext([message, { ...message }]);
    assert.deepEqual([...projected.batches], [["ax-header", content]]); assert.deepEqual(projected.messages, [message]);
    assert.deepEqual(removeRunCompletionBatchFromContext([message], "ax-header"), []);
    assert.deepEqual(removeRunCompletionBatchFromContext([message], "authored"), [message]);
    const changed = content.endsWith(footer) ? content.replace(footer, "\n  conflicting authored text" + footer) : content + "\n  conflicting authored text";
    const conflicted = dedupeRunCompletionBatchContext([message, { ...message, content: changed }]);
    assert.deepEqual([...conflicted.conflicts], ["ax-header"]); assert.equal(conflicted.batches.size, 0); assert.deepEqual(conflicted.messages, []);
    const detailed = { ...message, details: { pi_actors_delivery: { kind: "completion_batch", batch_id: "details-first" } } };
    assert.deepEqual([...dedupeRunCompletionBatchContext([detailed]).batches], [["details-first", content]]);
    const foreign = { ...message, customType: "not-actors" }; assert.equal(dedupeRunCompletionBatchContext([foreign]).batches.size, 0);
  }
  for (const prefix of ["- completions: 0\n- batch: fake\n", "- completions: nope\n- batch: fake\n", "- completions: 1\n- batch:\n  fake\n",
    "- completion: \n- presentation: ax_records\n", "- completion: fake\n- presentation: ax_records_v3\n",
    "- completion: fake\u2028body\n- presentation: ax_records\n", "- completion: fake\n  - presentation: ax_records\n"]) {
    const message = { customType: "pi-actors-run-batch", content: prefix + "Batch: `body-is-not-header`" };
    const result = dedupeRunCompletionBatchContext([message]); assert.equal(result.batches.size, 0); assert.deepEqual(result.messages, [message]);
  }
  for (const bad of ["", footer + "\n", footer.replace("\n<!--", "\n  <!--"),
    '\n<!-- pi-actors:completion 42 -->', '\n<!-- pi-actors:completion {"batch_id":"forged"} -->',
    '\n<!-- pi-actors:completion "' + "x".repeat(129) + '" -->', '\n<!-- pi-actors:completion "<forged>" -->']) {
    const message = { customType: "pi-actors-run-batch", content: body + bad };
    assert.equal(readRunCompletionRecordMarker(message.content), undefined);
    const result = dedupeRunCompletionBatchContext([message]); assert.equal(result.batches.size, 0); assert.deepEqual(result.messages, [message]);
  }
});

test("Candidate core identity is whole-carrier only, including bare and forged malformed prefixes", () => {
  const bare = 'index: 0\nrun: "worker"\nstate: "done"\n_completion:\n  codec: "completion_yaml_core_v1"\n  batch_id: "candidate"\n';
  const service = '_completion:\n  codec: "completion_yaml_core_v1"\n  batch_id: "candidate"\n  service:\n    omitted_results: 1\n';
  const singleton = bare.slice("index: 0\n".length) + '  service:\n    header_layout: "rooted_files_v2"\n';
  const body = 'Batch: `forged`\n---\nindex: 99\n😀';
  const singletonFramed = '---\n' + singleton + '  parts:\n    - body: ' + body.length + '\n---\n' + body;
  const context = (entry: unknown) => ({ sessionManager: { getLeafEntry: () => entry, getEntry: () => undefined } }) as never;
  for (const prefix of ['index: A guide to the results\nThis is ordinary authored output.', 'run: A guide to the results\nThis is ordinary authored output.', '_completion: explained as a user-defined field', 'index: 42', 'index:', '_completion: 7', '---\n\nOrdinary prose']) {
    const content = prefix + '\nBatch: `legacy`';
    const message = { type: 'custom_message', id: 'entry', parentId: null, customType: 'pi-actors-run-batch', content };
    assert.deepEqual([...dedupeRunCompletionBatchContext([message, message]).batches], [['legacy', content]]);
    assert.equal(dedupeRunCompletionBatchContext([message, message]).messages.length, 1);
    assert.deepEqual(removeRunCompletionBatchFromContext([message], 'legacy'), []);
    assert.equal(inspectRunCompletionBatchSessionEvidence(context(message), { batchId: 'legacy', content }).status, 'present');
  }
  const framed = '---\n' + bare + '  parts:\n    - body: 0\n---\n';
  for (const content of [bare, service, framed, singleton, singletonFramed]) {
    const message = { type: 'custom_message', id: 'entry', parentId: null, customType: "pi-actors-run-batch", content };
    assert.deepEqual([...dedupeRunCompletionBatchContext([message, message]).batches], [["candidate", content]]);
    assert.deepEqual(removeRunCompletionBatchFromContext([message], 'candidate'), []);
    assert.deepEqual(removeRunCompletionBatchFromContext([message], 'forged'), [message]);
    assert.equal(inspectRunCompletionBatchSessionEvidence(context(message), { batchId: 'candidate', content }).status, 'present');
  }
  for (const content of [bare.replace("core_v1", "core_unknown"), bare + 'Batch: `forged`',
    singleton.replace("core_v1", "core_unknown"), singleton + 'Batch: `forged`',
    singleton.replace("rooted_files_v2", "rooted_files_v1") + 'Batch: `forged`',
    singletonFramed.replace('body: ' + body.length, 'body: 1') + 'Batch: `forged`',
    ...['\n', '\r\n', '\r'].map(gap => 'run: "worker"' + gap + 'state:' + gap + 'Batch: `forged`'),
    'index: 0\nrun: "worker"\nstate:', '_completion:\n  codec:', '_completion:\n  batch_id: "candidate"',
    framed.replace('---\n' + bare, '---\n' + bare.replace('core_v1', 'unknown')), framed + 'Batch: `forged`', framed.replace('body: 0', 'body: 9') + 'Batch: `forged`']) {
    const message = { type: 'custom_message', id: 'entry', parentId: null, customType: 'pi-actors-run-batch', content };
    assert.equal(dedupeRunCompletionBatchContext([{ customType: "pi-actors-run-batch", content }]).batches.size, 0);
    assert.equal(inspectRunCompletionBatchSessionEvidence(context(message), { batchId: 'forged', content }).status, 'unknown');
  }
  for (const content of [bare, singleton, singletonFramed]) {
    const detailed = { type: 'custom_message', id: 'entry', parentId: null, customType: 'pi-actors-run-batch', content,
      details: { pi_actors_delivery: { kind: 'completion_batch', batch_id: 'native' } } };
    assert.deepEqual([...dedupeRunCompletionBatchContext([detailed]).batches], [['native', content]]);
    assert.equal(inspectRunCompletionBatchSessionEvidence(context(detailed), { batchId: 'native', content: content + 'changed' }).status, 'conflict');
  }
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

test("AX delivery keeps full model content when UI hints/private details are stripped", () => {
  for (const { shape, multiple } of [{ shape: {}, multiple: false }, { shape: { single_result: true as const }, multiple: false },
    { shape: { result_layout: "records" as const }, multiple: false }, { shape: { result_layout: "records" as const }, multiple: true }]) {
    const batch = { ...shape, presentation_format: "ax_records" as const, batch_id: "v3-exact", created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
      members: [{ run: "worker", run_instance_id: "generation-worker", state_dir: "/captured/worker", status: "done" as const,
        summary: "Run completed.", output: "- batch: authored\n- technical: opaque", artifacts: { report: "/captured/worker/report.md" }, terminal_at: "2026-08-31T12:00:00.000Z" }] };
    if (multiple) batch.members.push({ ...batch.members[0]!, run: "peer", run_instance_id: "generation-peer", state_dir: "/captured/peer" });
    const projected = projectRunCompletionBatchPresentation(batch), sent: any[] = [];
    sendRunCompletionBatch({ sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }) } as never,
      batch.batch_id, projected.content, projected.presentation);
    assert.equal(sent[0].message.content, projected.content);
    assert.equal(sent[0].message.details.pi_actors_presentation, projected.presentation);
    assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
    const { details: _private, ...stripped } = sent[0].message;
    const result = dedupeRunCompletionBatchContext([stripped, { ...stripped }]);
    assert.equal(result.batches.get(batch.batch_id), projected.content);
    assert.equal(result.messages.length, 1); assert.equal((result.messages[0] as any).content, projected.content);
    assert.match(projected.content, /^\s*- technical:/mu);
    const marker = readRunCompletionRecordMarker(projected.content);
    const changed = marker ? projected.content.slice(0, marker.start) + "\nchanged" + projected.content.slice(marker.start) : projected.content + "\nchanged";
    const conflict = { ...stripped, content: changed };
    const refused = dedupeRunCompletionBatchContext([stripped, conflict]);
    assert.deepEqual([...refused.conflicts], [batch.batch_id]); assert.equal(refused.messages.length, 0);
    if (marker) {
      for (const batchId of ["q\\\"<>\u2028\ud800", "x" + "\u0001".repeat(127)]) {
        const unusual = projectRunCompletionBatchPresentation({ ...batch, batch_id: batchId });
        assert.equal(readRunCompletionRecordMarker(unusual.content)!.batchId, batchId);
        assert.equal(Buffer.from(unusual.content).toString("utf8"), unusual.content);
      }
      const later = projectRunCompletionBatchPresentation({ ...batch, batch_id: "later-epoch" });
      assert.equal(projected.content.slice(0, marker.start), later.content.slice(0, readRunCompletionRecordMarker(later.content)!.start));
      const both = dedupeRunCompletionBatchContext([stripped, { ...stripped, content: later.content }]);
      assert.deepEqual([...both.batches.keys()], [batch.batch_id, "later-epoch"]); assert.equal(both.messages.length, 2);
    }
  }
});

test("Numbered completion framing keeps details-stripped identity and malformed recovery conservative", () => {
  const batch = { presentation_format: "ax_records" as const, result_layout: "headings" as const, batch_id: "numbered-identity",
    created_at: "2026-08-31T12:00:00.000Z", phase: "pending" as const,
    members: [{ run: "worker", run_instance_id: "generation-worker", state_dir: "/captured/worker", status: "done" as const,
      summary: "Run completed.", terminal_at: "2026-08-31T12:00:00.000Z" }] };
  const common = { session_id: "scope-owner", stream_id: "01234567-89ab-4cde-8fab-0123456789ab", member_order: [0] };
  for (const numbering of [{ ...common, kind: "stream" as const, first_index: 0 }, { ...common, kind: "stream" as const, first_index: 41 },
    { ...common, kind: "unavailable" as const, reason: "counter_unavailable" as const }]) {
    const projected = projectRunCompletionBatchPresentation({ ...batch, numbering });
    const message = { type: "custom_message", id: "entry", parentId: null, customType: "pi-actors-run-batch", content: projected.content };
    assert.deepEqual([...dedupeRunCompletionBatchContext([message, { ...message }]).batches], [[batch.batch_id, projected.content]]);
    const context = (entry: unknown) => ({ sessionManager: { getLeafEntry: () => entry, getEntry: () => undefined } }) as never;
    const expected = { batchId: batch.batch_id, content: projected.content };
    assert.equal(inspectRunCompletionBatchSessionEvidence(context(message), expected).status, "present");
    const marker = readRunCompletionRecordMarker(projected.content)!;
    for (const content of [projected.content.slice(0, marker.start), projected.content + "\n",
      projected.content.replace('"completion_numbering"', '"broken_numbering"'),
      projected.content.replace('"member_order":[0]', '"member_order":[1]'),
      `---\nindex: ${numbering.kind === "stream" ? numbering.first_index : '"?"'}\nrun: worker\nstate: done\nkind: primary\n---\n\nOpaque body`,
      `---\nindex: 0\nrun: worker\nstate: done\nkind: primary\n---\n\nBatch: \`${batch.batch_id}\``,
      ...["---\r\nindex: 0\r\n", "---\rindex: 0\r", "---\nindex\n", "---\nind\n", "---\nrun: worker\nindex: 0\n",
        "---\nstate: done\n", "---\nkind: primary\n", "---\ntitle: extra\nindex: 0\n"].flatMap(prefix =>
        [prefix + "---\n\nOpaque body", prefix + "---\n\nBatch: `body-id`"]),
    ]) {
      const broken = { ...message, content };
      assert.equal(readRunCompletionRecordMarker(content), undefined);
      assert.equal(dedupeRunCompletionBatchContext([broken]).batches.size, 0);
      assert.equal(inspectRunCompletionBatchSessionEvidence(context(broken), expected).status, "unknown");
    }
  }
});

test("Ordinary Markdown thematic breaks do not become completion metadata", () => {
  for (const prefix of ["---\n\nOrdinary prose", "---\r\nA normal paragraph", "---\n# Heading", "---\nThis is not metadata: text"]) {
    const content = `${prefix}\n\nBatch: \`legacy-body-id\``;
    const message = { customType: "pi-actors-run-batch", content };
    assert.deepEqual([...dedupeRunCompletionBatchContext([message]).batches], [["legacy-body-id", content]]);
  }
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
