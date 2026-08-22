import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveArtifactManifest } from "../lib/runs-artifacts.ts";

test("artifact manifests hash adversarial-size files with bounded chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-artifact-manifest-"));
  const file = join(root, "large.bin");
  try {
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const chunks = 128;
    await writeFile(file, Buffer.concat(Array.from({ length: chunks }, () => chunk)));
    const expected = createHash("sha256");
    for (let index = 0; index < chunks; index += 1) expected.update(chunk);
    const manifest = resolveArtifactManifest({
      report: { path: file, required: true },
    });
    assert.deepEqual(manifest?.report, {
      exists: true,
      path: file,
      required: true,
      sha256: expected.digest("hex"),
      size: chunk.byteLength * chunks,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
