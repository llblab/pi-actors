/**
 * Public tool access and ownership checks
 * Zones: session ownership, run visibility guards, tool authorization errors
 * Owns consistent session-mismatch diagnostics for public tool execution paths
 */
import * as AsyncRuns from "./async-runs.js";
import * as RunIndex from "./runs-index.js";
export function getContextSessionId(ctx) {
    return ctx?.sessionManager?.getSessionId?.();
}
/** Optional post-launch navigation never fails or rolls back work already admitted by the launch owner. */
export function readRunFileNavigationForContext(status, ctx) {
    try {
        const sessionId = getContextSessionId(ctx);
        const directory = Object.getOwnPropertyDescriptor(status, "state_dir");
        const navigation = RunIndex.readRunDirectoryNavigation(typeof directory?.value === "string" ? directory.value : "", status, sessionId);
        return getContextSessionId(ctx) === sessionId ? navigation : Object.freeze({ state: "unavailable", reason: "session_changed" });
    }
    catch {
        return Object.freeze({ state: "unavailable", reason: "navigation_unavailable" });
    }
}
export function requireContextSessionId(ctx, actor) {
    const sessionId = getContextSessionId(ctx);
    if (!sessionId) {
        throw Object.assign(new Error(`${actor} reason=session_unavailable requires a current coordinator session; retry from an active coordinator session.`), { reason: "session_unavailable" });
    }
    return sessionId;
}
export function sessionMismatchError(input) {
    const ownerSession = input.expectedSession ?? "none";
    const currentSession = input.currentSession ?? "none";
    const actor = input.run ? `run:${input.run}` : (input.target ?? "session");
    return Object.assign(new Error(`${actor} reason=session_mismatch owner_session=${ownerSession} current_session=${currentSession} hint=inspect_runtime_runs`), {
        current_session: input.currentSession,
        hint: "inspect target=runtime view=runs",
        owner_session: input.expectedSession,
        reason: "session_mismatch",
        run: input.run,
        target: input.target,
    });
}
export function assertRunStatusAccessibleToContext(runId, status, ctx) {
    const sessionId = requireContextSessionId(ctx, `run:${runId}`);
    const ownerId = typeof status.ownerId === "string" && status.ownerId
        ? status.ownerId
        : undefined;
    if (ownerId !== sessionId) {
        throw sessionMismatchError({
            currentSession: sessionId,
            expectedSession: ownerId,
            run: runId,
        });
    }
    return status;
}
export function assertRunAccessibleToContext(runId, ctx) {
    return assertRunStatusAccessibleToContext(runId, AsyncRuns.getRunStatus(runId), ctx);
}
