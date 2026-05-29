/**
 * Public tool access and ownership checks
 * Zones: session ownership, run visibility guards, tool authorization errors
 * Owns consistent session-mismatch diagnostics for public tool execution paths
 */

import * as AsyncRuns from "./async-runs.ts";

export interface SessionContext {
  sessionManager?: { getSessionId?: () => string };
}

export function getContextSessionId(ctx: unknown): string | undefined {
  return (ctx as SessionContext | undefined)?.sessionManager?.getSessionId?.();
}

export function requireContextSessionId(ctx: unknown, actor: string): string {
  const sessionId = getContextSessionId(ctx);
  if (!sessionId) {
    throw new Error(
      `${actor} requires a current coordinator session; use session:<id> or session:all for explicit session inventory.`,
    );
  }
  return sessionId;
}

export function sessionMismatchError(input: {
  currentSession?: string;
  expectedSession?: string;
  run?: string;
  target?: string;
}): Error {
  const ownerSession = input.expectedSession ?? "none";
  const currentSession = input.currentSession ?? "none";
  const actor = input.run ? `run:${input.run}` : (input.target ?? "session");
  const hintTarget = input.expectedSession
    ? `session:${input.expectedSession}`
    : "session:all";
  return Object.assign(
    new Error(
      `${actor} reason=session_mismatch owner_session=${ownerSession} current_session=${currentSession} hint=inspect_session:${input.expectedSession ?? "all"}`,
    ),
    {
      current_session: input.currentSession,
      hint: `inspect target=${hintTarget} view=status`,
      owner_session: input.expectedSession,
      reason: "session_mismatch",
      run: input.run,
      target: input.target,
    },
  );
}

export function assertRunAccessibleToContext(
  runId: string,
  ctx: unknown,
): Record<string, unknown> {
  const status = AsyncRuns.getRunStatus(runId);
  const sessionId = getContextSessionId(ctx);
  if (sessionId && status.ownerId && status.ownerId !== sessionId) {
    throw sessionMismatchError({
      currentSession: sessionId,
      expectedSession: String(status.ownerId),
      run: runId,
    });
  }
  return status;
}
