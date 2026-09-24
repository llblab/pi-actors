/**
 * Run Control delivery.
 * Zones: generation-fenced endpoint resolution, FIFO/named-pipe writes, durable outcomes
 * Owns delivery of persisted actor-local Controls to ready service endpoints.
 */
export interface RunControlEndpoint {
    path: string;
    type: "fifo" | "named-pipe";
}
export interface DeliverRunControlOptions {
    namedPipeSend?: (path: string, payload: string) => Promise<number>;
    platform?: NodeJS.Platform;
}
export interface DeliverRunControlRequest {
    action: string;
    input?: unknown;
    run_instance_id: string;
}
export declare function encodeRunControlWire(wire: {
    action: string;
    id: string;
    input?: unknown;
}): {
    bytes: number;
    payload: string;
};
export declare function readRunControlEndpoint(stateDir: string, runInstanceId: string): RunControlEndpoint | undefined;
export declare function deliverRunControl(run: string, stateDir: string, request: DeliverRunControlRequest, options?: DeliverRunControlOptions): Promise<Record<string, unknown>>;
