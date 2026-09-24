/**
 * Run-owned execution session evidence.
 * Zones: execution manifest session discovery, canonical containment, rich turn correlation
 * Owns reusable agent-turn loading; Trace and TUI projection stay in their adapters.
 */
import * as SessionEvidence from "./session-evidence.ts";
export interface ExecutionTurnItem extends SessionEvidence.SessionEvidenceTurn {
    commandId: string;
    diagnostics: string[];
    promptBytes?: number;
    promptFile?: string;
    recipeContext?: unknown;
    sessionFile: string;
    sessionTruncated: boolean;
    stage?: string;
}
export declare function readExecutionTurns(stateDir: string): ExecutionTurnItem[];
