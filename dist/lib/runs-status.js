/**
 * Async run status and log readers.
 * Owns: status derivation from run state files plus bounded log/event tails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyRunProcessIdentity, } from "./runs-process.js";
import { readJsonlFileResilient } from "./state-readers.js";
function getInterruptedRunStatus(stateDir) {
    const trace = readJsonlFileResilient(join(stateDir, "trace.jsonl")).records.slice(-200);
    for (const event of trace.reverse()) {
        if (event.kind === "run.kill")
            return "killed";
        if (event.kind === "run.cancel")
            return "cancelled";
    }
    const legacyEvents = readJsonlFileResilient(join(stateDir, "events.jsonl")).records.slice(-200);
    for (const event of legacyEvents.reverse()) {
        if (event.event === "run.kill")
            return "killed";
        if (event.event === "run.cancel")
            return "cancelled";
    }
    return undefined;
}
export function buildRunStatus(stateDir, runOrDir, meta, readJson, _runnerPath, _runnerIdentityGraceMs) {
    const result = readJson(join(stateDir, "result.json"));
    const pid = Number(meta.pid || 0);
    const processIdentity = verifyRunProcessIdentity(pid, meta.process_identity);
    const aliveOwnedRunner = Boolean(pid &&
        (processIdentity.valid || processIdentity.status === "unsupported_proof"));
    const status = result
        ? Number(result.code ?? 0) === 0
            ? "done"
            : "failed"
        : aliveOwnedRunner
            ? "running"
            : (getInterruptedRunStatus(stateDir) ?? "exited");
    const terminalHandled = readJson(join(stateDir, "terminal-handled.json"));
    const terminalDeliveryFailure = readJson(join(stateDir, "terminal-delivery-failure.json"));
    return {
        ...meta,
        traceFile: join(stateDir, "trace.jsonl"),
        executionFile: join(stateDir, "execution.json"),
        process_identity_status: processIdentity.status,
        progress: readJson(join(stateDir, "progress.json")) || null,
        result: result || null,
        ...(terminalDeliveryFailure
            ? { terminal_delivery_failure: terminalDeliveryFailure } : {}),
        ...(terminalHandled ? { terminal_handled: terminalHandled } : {}),
        state_dir: String(meta.state_dir ?? stateDir),
        stderrLog: join(stateDir, "stderr.log"),
        stdoutLog: join(stateDir, "stdout.log"),
        status,
    };
}
export function tailFile(path, lines) {
    if (!existsSync(path))
        return "";
    const content = readFileSync(path, "utf8").trimEnd();
    if (!content)
        return "";
    return content.split("\n").slice(-lines).join("\n");
}
export function tailLines(path, lines) {
    const content = tailFile(path, lines);
    return content ? content.split("\n") : [];
}
