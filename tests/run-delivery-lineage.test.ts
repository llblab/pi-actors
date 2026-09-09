import assert from "node:assert/strict";
import test from "node:test";

import {
  getProcessDeliveryOwnerId,
  inheritedRunDeliveryLineage,
  runDeliveryChildEnv,
} from "../lib/run-delivery-lineage.ts";

test("Run delivery lineage keeps one root owner while advancing the parent generation", () => {
  const root = inheritedRunDeliveryLineage("session-root", {});
  assert.deepEqual(root, { delivery_owner_id: "session-root" });
  const childEnv = runDeliveryChildEnv(root!, {
    run: "top",
    run_instance_id: "generation-top",
    state_dir: "/runs/top",
  }, {});
  assert.equal(getProcessDeliveryOwnerId(childEnv), "session-root");
  const nested = inheritedRunDeliveryLineage("session-child", childEnv);
  assert.deepEqual(nested, {
    delivery_owner_id: "session-root",
    delivery_parent: {
      run: "top",
      run_instance_id: "generation-top",
      state_dir: "/runs/top",
    },
  });
  const grandchildEnv = runDeliveryChildEnv(nested!, {
    run: "nested",
    run_instance_id: "generation-nested",
    state_dir: "/runs/nested",
  }, childEnv);
  assert.deepEqual(inheritedRunDeliveryLineage("session-grandchild", grandchildEnv), {
    delivery_owner_id: "session-root",
    delivery_parent: {
      run: "nested",
      run_instance_id: "generation-nested",
      state_dir: "/runs/nested",
    },
  });
});

test("Run delivery lineage rejects partial inherited ancestry", () => {
  assert.throws(
    () => inheritedRunDeliveryLineage("session-child", {
      PI_ACTORS_DELIVERY_OWNER_ID: "session-root",
      PI_ACTORS_DELIVERY_PARENT_RUN: "top",
    }),
    /parent lineage is incomplete/,
  );
});
