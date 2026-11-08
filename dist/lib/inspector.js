/**
 * Actor Inspector owned-Run evidence and actions.
 * Zones: owned inventory, captured Recipe reads, exact-session/generation action fencing
 * Owns Inspector domain operations; command/overlay wiring and lifecycle actuation stay in adapters.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { projectRunRecipe } from "./recipe-projection.js";
import { safeRunId } from "./runs-identity.js";
import { readJsonFileResilient } from "./state-readers.js";
import { formatMarkdownField } from "./tools-response.js";
function matchesOwner(stateDir, ownerId) {
    const meta = readJsonFileResilient(path.join(stateDir, "run.json"), {}).value;
    return meta.ownerId === ownerId;
}
export function readActorInspectorRuns(stateRoot, ownerId) {
    try {
        return fs
            .readdirSync(stateRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) => {
            const stateDir = path.join(stateRoot, entry.name);
            if (!matchesOwner(stateDir, ownerId))
                return [];
            const runMeta = readJsonFileResilient(path.join(stateDir, "run.json"), {}).value;
            const progress = readJsonFileResilient(path.join(stateDir, "progress.json"), {}).value;
            const result = readJsonFileResilient(path.join(stateDir, "result.json"), {}).value;
            return [{
                    run: entry.name,
                    ...(typeof runMeta.run_instance_id === "string"
                        ? { runInstanceId: runMeta.run_instance_id }
                        : {}),
                    status: String(progress.phase ??
                        (Object.keys(result).length ? "terminal" : "unknown")),
                    ...(typeof progress.updatedAt === "string"
                        ? { updatedAt: progress.updatedAt }
                        : typeof result.completedAt === "string"
                            ? { updatedAt: result.completedAt }
                            : {}),
                }];
        })
            .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")) ||
            right.run.localeCompare(left.run));
    }
    catch {
        return [];
    }
}
export function readActorInspectorRecipe(stateDir) {
    const result = readJsonFileResilient(path.join(stateDir, "run.json"), {});
    return projectRunRecipe(result.value, result.diagnostics.map(diagnostic => diagnostic.message));
}
const FEEDBACK_LIMIT = 180;
/** Pure presentation of an already selected value; legacy metadata grants no source/privacy authority. */
export function formatActorInspectorKillFeedback(result, selected, legacy) {
    const key = result === "unavailable" ? "state" : "diagnostic";
    const fields = [formatMarkdownField("action", "kill"), formatMarkdownField("result", result)];
    if (Buffer.from(selected).toString("utf8") !== selected) {
        fields.push(formatMarkdownField(key, "unavailable"), formatMarkdownField(`${key}_reason`, "malformed_legacy_preview"), formatMarkdownField(`${key}_omission`, "[omitted: unknown]"));
    }
    else {
        fields.push(formatMarkdownField(key, selected + (legacy?.clipped ? "…" : "")));
        if (legacy?.clipped)
            fields.push(formatMarkdownField(`${key}_omission`, "[omitted: unknown]"));
    }
    if (legacy)
        fields.push(formatMarkdownField("preview_basis", "selected legacy preview; upstream completeness/privacy unproven"));
    fields.push(formatMarkdownField("closure", "unconfirmed"));
    if (result === "failed")
        fields.push(formatMarkdownField("safety", "Do not repeat automatically."));
    return fields.join("\n");
}
function bounded(result, value) {
    const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
    const clipped = text.length > FEEDBACK_LIMIT;
    let end = clipped ? FEEDBACK_LIMIT - 1 : text.length;
    if (clipped && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end]))
        end -= 1;
    return formatActorInspectorKillFeedback(result, clipped ? text.slice(0, end) : text, { clipped });
}
export function killOwnedRunFromInspector(ownerId, run, stateRoot, expectedRunInstanceId, deps) {
    let stateDir;
    try {
        stateDir = join(stateRoot, safeRunId(run));
    }
    catch (error) {
        return {
            ok: false,
            message: bounded("rejected", error instanceof Error ? error.message : error),
        };
    }
    try {
        const status = deps.getRunStatus(stateDir);
        if (status.ownerId !== ownerId) {
            return { ok: false, message: formatActorInspectorKillFeedback("rejected", "run ownership changed.") };
        }
        if (status.status !== "running") {
            return {
                ok: false,
                message: bounded("unavailable", status.status || "terminal"),
            };
        }
        if (status.run_instance_id !== expectedRunInstanceId) {
            return { ok: false, message: formatActorInspectorKillFeedback("rejected", "run generation changed.") };
        }
        const result = deps.killRun(stateDir, {
            ownerId,
            runInstanceId: expectedRunInstanceId,
        });
        if (result.killed === true) {
            return { ok: true, message: `Killed run:${run}.` };
        }
        return {
            ok: false,
            message: bounded("failed", result.reason || "control rejected"),
        };
    }
    catch (error) {
        return {
            ok: false,
            message: bounded("failed", error instanceof Error ? error.message : error),
        };
    }
}
