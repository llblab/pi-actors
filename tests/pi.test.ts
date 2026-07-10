import assert from "node:assert/strict";
import test from "node:test";

import { createNotificationSink } from "../lib/pi.ts";

test("Actor notifications steer busy agents and trigger an idle turn", () => {
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
    display: true as const,
    details: { run: "review" },
  };
  sink.sendSteering(message);
  assert.deepEqual(sent, [
    {
      message,
      options: { deliverAs: "steer", triggerTurn: true },
    },
  ]);
});
