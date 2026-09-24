/**
 * Run Control request contract.
 * Zones: public request validation, Run/runtime target normalization, input bounds
 * Owns pure Control validation; journaling, delivery, and lifecycle mutation stay in adapters.
 */
export interface ControlRequest {
    target: `run:${string}` | "runtime";
    action: string;
    input?: unknown;
    verbose?: boolean;
}
export declare function isControlAction(value: string): boolean;
export declare function normalizeControlAction(value: unknown): string;
export declare function normalizeControlInput(input: unknown): unknown;
export declare function normalizeControlRequest(input: unknown): ControlRequest;
