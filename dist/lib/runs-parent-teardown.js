/**
 * Parent-session actor teardown.
 * Owns: exact-owner running-run selection, kill revalidation, bounded outcomes, and partial-failure continuation.
 */
const SUMMARY_ENTRY_LIMIT = 200;
const SUMMARY_TEXT_LIMIT = 500;
function boundedSummaryText(value) {
    return value.length > SUMMARY_TEXT_LIMIT
        ? `${value.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`
        : value;
}
export function buildBoundedParentTeardownSummary(result, ownerId, trigger, ts) {
    const attempts = result.attempts.slice(0, SUMMARY_ENTRY_LIMIT).map((attempt) => ({
        ownerId: boundedSummaryText(attempt.ownerId),
        outcome: attempt.outcome,
        ...(attempt.reason ? { reason: boundedSummaryText(attempt.reason) } : {}),
        run: boundedSummaryText(attempt.run),
        ...(attempt.runInstanceId
            ? { runInstanceId: boundedSummaryText(attempt.runInstanceId) }
            : {}),
        stateDir: boundedSummaryText(attempt.stateDir),
    }));
    const discoveryFailures = result.discoveryFailures
        .slice(0, SUMMARY_ENTRY_LIMIT)
        .map((failure) => ({
        path: boundedSummaryText(failure.path),
        reason: boundedSummaryText(failure.reason),
    }));
    return {
        attempted: result.attempted,
        attempts,
        attemptsOmitted: Math.max(0, result.attempts.length - attempts.length),
        discoveryFailed: result.discoveryFailed,
        discoveryFailures,
        discoveryFailuresOmitted: Math.max(0, result.discoveryFailures.length - discoveryFailures.length),
        failed: result.failed,
        killed: result.killed,
        ownerId: boundedSummaryText(ownerId),
        skipped: result.skipped,
        trigger: boundedSummaryText(trigger),
        ts: boundedSummaryText(ts),
        version: 1,
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function candidateFrom(ownerId, status) {
    if (status.ownerId !== ownerId ||
        status.status !== "running" ||
        typeof status.run !== "string" ||
        typeof status.state_dir !== "string") {
        return undefined;
    }
    return {
        ownerId,
        run: status.run,
        ...(typeof status.run_instance_id === "string"
            ? { runInstanceId: status.run_instance_id }
            : {}),
        stateDir: status.state_dir,
    };
}
export function selectParentRunTeardownCandidates(ownerId, statuses) {
    if (!ownerId)
        return [];
    const byStateDir = new Map();
    for (const status of statuses) {
        const candidate = candidateFrom(ownerId, status);
        if (candidate && !byStateDir.has(candidate.stateDir)) {
            byStateDir.set(candidate.stateDir, candidate);
        }
    }
    return [...byStateDir.values()].sort((left, right) => left.run.localeCompare(right.run));
}
function recordAttempt(deps, attempt) {
    try {
        deps.recordAttempt(attempt);
        return attempt;
    }
    catch (error) {
        return {
            ...attempt,
            outcome: "failed",
            reason: `${attempt.reason ? `${attempt.reason}; ` : ""}evidence: ${errorMessage(error)}`,
        };
    }
}
export function teardownParentRuns(ownerId, deps) {
    let discovery;
    try {
        const listed = deps.listRunStatuses();
        discovery = Array.isArray(listed)
            ? { failures: [], statuses: listed }
            : listed;
    }
    catch (error) {
        discovery = {
            failures: [{ path: "<state-root>", reason: errorMessage(error) }],
            statuses: [],
        };
    }
    const candidates = selectParentRunTeardownCandidates(ownerId, discovery.statuses);
    const attempts = [];
    for (const candidate of candidates) {
        let attempt;
        try {
            const current = deps.getRunStatus(candidate.stateDir);
            if (!candidate.runInstanceId) {
                attempt = {
                    ...candidate,
                    outcome: "failed",
                    reason: "run generation unavailable",
                };
            }
            else if (current.ownerId !== candidate.ownerId) {
                attempt = {
                    ...candidate,
                    outcome: "skipped",
                    reason: "ownership changed",
                };
            }
            else if (current.run_instance_id !== candidate.runInstanceId) {
                attempt = {
                    ...candidate,
                    outcome: "skipped",
                    reason: "run generation changed",
                };
            }
            else if (current.status !== "running") {
                attempt = {
                    ...candidate,
                    outcome: "skipped",
                    reason: "already terminal",
                };
            }
            else {
                const killed = deps.killRun(candidate.stateDir, {
                    ownerId: candidate.ownerId,
                    runInstanceId: candidate.runInstanceId,
                });
                attempt = killed.killed === true
                    ? { ...candidate, outcome: "killed" }
                    : {
                        ...candidate,
                        outcome: "failed",
                        reason: typeof killed.reason === "string"
                            ? killed.reason
                            : "kill rejected",
                    };
            }
        }
        catch (error) {
            attempt = {
                ...candidate,
                outcome: "failed",
                reason: errorMessage(error),
            };
        }
        attempts.push(recordAttempt(deps, attempt));
    }
    return {
        attempted: candidates.length,
        discoveryFailed: discovery.failures.length,
        discoveryFailures: discovery.failures,
        failed: attempts.filter((attempt) => attempt.outcome === "failed").length +
            discovery.failures.length,
        killed: attempts.filter((attempt) => attempt.outcome === "killed").length,
        skipped: attempts.filter((attempt) => attempt.outcome === "skipped").length,
        attempts,
    };
}
