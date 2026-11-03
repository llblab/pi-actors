/**
 * Bounded Run observation projection.
 * Owns: one data-only snapshot shape from already-admitted identity/lifecycle/timing facts.
 * Excludes: evidence reads/admission, reference authorization/redaction, clocks, exports,
 * lifecycle mutation, delivery acceptance, and native work/control/scope authority.
 */
import { RUN_DELIVERY_MODEL_MAX_BYTES } from "./limits.js";
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function own(value, key) {
    return value && Object.hasOwn(value, key) ? value[key] : undefined;
}
function boundedText(value) {
    return typeof value === "string" && value.length > 0 && value.length <= RUN_DELIVERY_MODEL_MAX_BYTES;
}
function readIdentity(value) {
    const source = record(value);
    const run = own(source, "run");
    const generation = own(source, "run_instance_id");
    if (!boundedText(run) || /[^A-Za-z0-9_.-]/u.test(run) || !boundedText(generation))
        return undefined;
    if (source && Object.hasOwn(source, "ownerId")) {
        if (!boundedText(source.ownerId))
            return undefined;
        return { run, run_instance_id: generation, ownerId: source.ownerId };
    }
    if (source?.ownerId !== undefined)
        return undefined;
    return { run, run_instance_id: generation };
}
function sameIdentity(left, right) {
    return left.run === right.run && left.run_instance_id === right.run_instance_id && left.ownerId === right.ownerId;
}
function readableReference(value) {
    return boundedText(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function unavailable(reason) {
    return Object.freeze({ state: "unavailable", reason });
}
/** Facts and curated references must be admitted by their owners before projection; no I/O or authority is acquired here. */
export function projectRunSnapshot(expected, facts) {
    const expectedIdentity = readIdentity(expected);
    const source = record(facts);
    const identity = readIdentity(own(source, "identity"));
    if (!expectedIdentity || !identity)
        return unavailable("identity_unavailable");
    if (!sameIdentity(expectedIdentity, identity))
        return unavailable("identity_mismatch");
    const capturedAt = own(source, "captured_at");
    if (!boundedText(capturedAt))
        return unavailable("observation_unavailable");
    const capturedMs = Date.parse(capturedAt);
    if (!Number.isSafeInteger(capturedMs) || new Date(capturedMs).toISOString() !== capturedAt) {
        return unavailable("observation_unavailable");
    }
    const lifecycle = record(own(source, "lifecycle"));
    const status = own(lifecycle, "status");
    const phase = own(lifecycle, "phase");
    if ((status !== "running" && status !== "done" && status !== "failed") ||
        (phase !== undefined && (status !== "running" || phase !== "stopping"))) {
        return unavailable("lifecycle_unproven");
    }
    const timing = record(own(source, "timing"));
    const elapsedMs = own(timing, "elapsed_ms");
    if (own(timing, "basis") !== (status === "running" ? "live" : "terminal") ||
        typeof elapsedMs !== "number" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
        return unavailable("timing_unproven");
    }
    const cwd = own(source, "cwd");
    if (typeof cwd === "string" && cwd.length > RUN_DELIVERY_MODEL_MAX_BYTES)
        return unavailable("snapshot_too_large");
    if (!readableReference(cwd))
        return unavailable("references_unavailable");
    const index = record(own(source, "context_index"));
    const indexIdentity = readIdentity(own(index, "identity"));
    const indexPath = own(index, "path");
    const evidence = indexIdentity && sameIdentity(identity, indexIdentity) && readableReference(indexPath) ? indexPath : null;
    const snapshot = Object.freeze({
        kind: "run_snapshot", run: identity.run, run_instance_id: identity.run_instance_id,
        captured_at: capturedAt, elapsed_ms: elapsedMs, status,
        ...(phase === "stopping" ? { phase } : {}), cwd, evidence,
        ...(evidence === null ? { evidence_error: "index_unavailable" } : {}),
    });
    // This is a row ceiling, not a second allowance: delivery still bounds the combined packet.
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > RUN_DELIVERY_MODEL_MAX_BYTES) {
        return unavailable("snapshot_too_large");
    }
    return Object.freeze({ state: "available", snapshot });
}
