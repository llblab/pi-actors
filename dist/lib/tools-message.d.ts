/**
 * Public Control facade under the stable `message` tool name.
 * Zones: Control request validation, Run/runtime dispatch, compact receipts
 * Owns public Control execution; journaling, delivery, and lifecycle mutation stay in Run domains.
 */
export interface ControlToolDeps {
    getRunStatus?: (run: string) => Record<string, unknown>;
    handleRuntimeControl?: (action: string, input: unknown) => Record<string, unknown>;
}
export declare function createControlToolDefinition<TContext = unknown>(deps?: ControlToolDeps): any;
