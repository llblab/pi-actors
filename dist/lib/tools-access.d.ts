/**
 * Public tool access and ownership checks
 * Zones: session ownership, run visibility guards, tool authorization errors
 * Owns consistent session-mismatch diagnostics for public tool execution paths
 */
import * as RunIndex from "./runs-index.ts";
export interface SessionContext {
    sessionManager?: {
        getSessionId?: () => string;
    };
}
export declare function getContextSessionId(ctx: unknown): string | undefined;
/** Optional post-launch navigation never fails or rolls back work already admitted by the launch owner. */
export declare function readRunFileNavigationForContext(status: object, ctx: unknown): Readonly<RunIndex.RunDirectoryNavigation>;
export declare function requireContextSessionId(ctx: unknown, actor: string): string;
export declare function sessionMismatchError(input: {
    currentSession?: string;
    expectedSession?: string;
    run?: string;
    target?: string;
}): Error;
export declare function assertRunStatusAccessibleToContext(runId: string, status: Record<string, unknown>, ctx: unknown): Record<string, unknown>;
export declare function assertRunAccessibleToContext(runId: string, ctx: unknown): Record<string, unknown>;
