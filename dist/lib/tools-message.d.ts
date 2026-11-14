/**
 * Public Control facade under the stable `actors_control_apply` tool name.
 * Zones: Control request validation, Run/runtime dispatch, recipient-scoped receipts
 * Owns public Control execution; journaling, delivery, and lifecycle mutation stay in Run domains.
 */
import * as Control from "./control.ts";
/** Pure first-layer copy; legacy stopped/killed flags are not scope-closure proof. */
export declare function compactControlResult(request: Control.ControlRequest, result: Record<string, unknown>): string;
export interface ControlToolDeps {
    getRunStatus?: (run: string) => Record<string, unknown>;
    handleRuntimeControl?: (action: string, input: unknown) => Record<string, unknown>;
}
export declare function createControlToolDefinition<TContext = unknown>(deps?: ControlToolDeps): any;
