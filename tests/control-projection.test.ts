import assert from "node:assert/strict";
import test from "node:test";

import { projectRunControl } from "../lib/control-projection.ts";
import * as Limits from "../lib/limits.ts";
import type { RunControlRecord } from "../lib/runs-controls.ts";

function record(input: unknown, error?: string): RunControlRecord {
  return {
    id: "control-1",
    run_instance_id: "generation-a",
    action: "pause",
    input,
    status: error ? "failed" : "handled",
    queued_at: "2026-01-01T00:00:00.000Z",
    delivered_at: "2026-01-01T00:00:01.000Z",
    claimed_at: "2026-01-01T00:00:02.000Z",
    ...(error
      ? { error, failed_at: "2026-01-01T00:00:03.000Z" }
      : { handled_at: "2026-01-01T00:00:03.000Z" }),
  };
}

test("Control projection redacts nested keys and inline credential strings", () => {
  const raw = record(
    {
      password: "CONTROL_PASSWORD_SECRET",
      token: "CONTROL_TOKEN_SECRET",
      secret: "CONTROL_SECRET_VALUE",
      authorization: "CONTROL_AUTH_SECRET",
      cookie: "CONTROL_COOKIE_SECRET",
      private_key: "CONTROL_PRIVATE_KEY_SECRET",
      nested: {
        apiKey: "CONTROL_API_KEY_SECRET",
        accessToken: "CONTROL_ACCESS_TOKEN_SECRET",
        clientSecret: "CONTROL_CLIENT_SECRET",
        privateKey: "CONTROL_CAMEL_PRIVATE_SECRET",
        secretAccessKey: "CONTROL_ACCESS_KEY_SECRET",
        inline: "token=CONTROL_INLINE_SECRET",
        bearer: "Bearer CONTROL_BEARER_SECRET",
        safe: "visible",
      },
    },
    `authorization=CONTROL_ERROR_SECRET ${"x".repeat(500)}`,
  );
  const before = structuredClone(raw);
  const projected = projectRunControl(raw);
  const serialized = JSON.stringify(projected);
  for (const sentinel of [
    "CONTROL_PASSWORD_SECRET",
    "CONTROL_TOKEN_SECRET",
    "CONTROL_SECRET_VALUE",
    "CONTROL_AUTH_SECRET",
    "CONTROL_COOKIE_SECRET",
    "CONTROL_PRIVATE_KEY_SECRET",
    "CONTROL_API_KEY_SECRET",
    "CONTROL_ACCESS_TOKEN_SECRET",
    "CONTROL_CLIENT_SECRET",
    "CONTROL_CAMEL_PRIVATE_SECRET",
    "CONTROL_ACCESS_KEY_SECRET",
    "CONTROL_INLINE_SECRET",
    "CONTROL_BEARER_SECRET",
    "CONTROL_ERROR_SECRET",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sentinel));
  }
  const small = projectRunControl(record({
    nested: {
      password: "SMALL_PASSWORD_SECRET",
      apiKey: "SMALL_API_SECRET",
      note: "token=SMALL_INLINE_SECRET",
      safe: "visible",
    },
  }));
  const nested = (small.input as { nested: Record<string, unknown> }).nested;
  assert.equal(nested.password, "[REDACTED]");
  assert.equal(nested.apiKey, "[REDACTED]");
  assert.equal(nested.note, "token=[REDACTED]");
  assert.equal(nested.safe, "visible");
  assert.match(projected.error ?? "", /\[REDACTED\]/);
  assert.ok((projected.error?.length ?? 0) <= Limits.INSPECTOR_BODY_PREVIEW_CHARS);
  assert.equal(projected.id, raw.id);
  assert.equal(projected.run_instance_id, raw.run_instance_id);
  assert.equal(projected.action, raw.action);
  assert.equal(projected.status, raw.status);
  assert.equal(projected.failed_at, raw.failed_at);
  assert.deepEqual(raw, before);
});

test("Control projection bounds large structured input and handles circular values", () => {
  const large = record(Array.from({ length: 100 }, (_, index) => ({
    index,
    note: "x".repeat(500),
    token: `LARGE_SECRET_${index}`,
  })));
  const largeProjection = projectRunControl(large);
  assert.ok(
    JSON.stringify(largeProjection.input).length <=
      Limits.INSPECTOR_BODY_PREVIEW_CHARS,
  );
  assert.equal((largeProjection.input as Record<string, unknown>).truncated, true);
  assert.doesNotMatch(JSON.stringify(largeProjection.input), /LARGE_SECRET_/);

  const circular: Record<string, unknown> = {
    password: "CIRCULAR_SECRET",
  };
  circular.self = circular;
  const circularProjection = projectRunControl(record(circular));
  assert.deepEqual(circularProjection.input, {
    password: "[REDACTED]",
    self: "[CIRCULAR]",
  });
  assert.equal(circular.self, circular);
  assert.equal(circular.password, "CIRCULAR_SECRET");
});
