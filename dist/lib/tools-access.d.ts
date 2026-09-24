/**
 * Public tool access and ownership checks
 * Zones: session ownership, run visibility guards, tool authorization errors
 * Owns consistent session-mismatch diagnostics for public tool execution paths
 */
export interface SessionContext {
    sessionManager?: {
        getSessionId?: () => string;
    };
}
export declare function getContextSessionId(ctx: unknown): string | undefined;
export declare function requireContextSessionId(ctx: unknown, actor: string): string;
export declare function sessionMismatchError(input: {
    currentSession?: string;
    expectedSession?: string;
    run?: string;
    target?: string;
}): Error;
export declare function assertRunStatusAccessibleToContext(runId: string, status: Record<string, unknown>, ctx: unknown): Record<string, unknown>;
export declare function assertRunAccessibleToContext(runId: string, ctx: unknown): Record<string, unknown>;
